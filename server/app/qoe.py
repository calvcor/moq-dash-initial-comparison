"""Módulo de evaluación de QoE en streaming de baja latencia (LL-GABR + VMAF).

Implementa la formulación de QoE de LL-GABR (Raman et al., Buffalo/IBM 2024) combinada con
mediciones de fidelidad espacial (VMAF) y distorsiones temporales (parones y latencia glass-to-glass)
para comparar objetivamente LL-DASH, MoQ y WebRTC.
"""

import json
import logging
import math
import os
import subprocess
import tempfile
import time
from typing import Dict, List, Optional
from pydantic import BaseModel, Field

logger = logging.getLogger("orchestrator")

# Pesos originales de LL-GABR (Raman et al., 2024, Sección 4.3)
ALPHA_BASE = 0.077  # Calidad visual VMAF escalada a [0, 5]
BETA_STALL = 1.249  # Penalización por segundo total congelado
GAMMA_STALL = 2.897 # Penalización por cada corte/evento de rebuffering
SIGMA_LATENCY = 1.249 # Penalización por latencia media (en segundos)
MU_SPEED = 0.771    # Penalización por aceleración/frenado de catch-up (|1 - speed|)
OMEGA_SMOOTH = 1.436 # Penalización por fluctuaciones bruscas de calidad (|ΔVMAF| / 20)

# Duración estándar de episodio en el paper de LL-GABR (300 segundos)
REFERENCE_DURATION_S = 300.0


class QoEFrameSample(BaseModel):
    wall_time_ms: float = Field(..., description="Timestamp de reloj del navegador")
    timecode_ms: int = Field(..., description="Timecode binario leído del fotograma")
    rendition_height: int = Field(1080, description="Altura en píxeles de la representación reproducida")
    latency_ms: float = Field(..., description="Latencia de cristal a cristal en milisegundos")
    playback_rate: float = Field(1.0, description="Velocidad efectiva de reproducción en ese frame")


class QoEStallEvent(BaseModel):
    start_wall_time_ms: float = Field(..., description="Instante de inicio del parón en reloj del cliente")
    duration_ms: float = Field(..., description="Duración total del parón en ms")
    frozen_timecode_ms: int = Field(..., description="Timecode del fotograma congelado")


class QoEEvaluationRequest(BaseModel):
    protocol: str = Field(..., description="'dash' | 'moq' | 'rtc'")
    duration_s: float = Field(..., ge=5.0, le=300.0, description="Duración prevista de la prueba en segundos")
    frames: List[QoEFrameSample] = Field(default_factory=list)
    stalls: List[QoEStallEvent] = Field(default_factory=list)
    target_latency_ms: Optional[float] = None


class QoESecondTimeline(BaseModel):
    sec: int
    vmaf: float
    freeze_s: float
    stalls_count: int
    latency_s: float
    speed: float
    delta_vmaf: float
    frames_count: int
    rendition_height: int


class QoEPenalties(BaseModel):
    visual_quality_score: float
    freeze_penalty: float
    stall_count_penalty: float
    latency_penalty: float
    catchup_penalty: float
    smoothness_penalty: float


class QoEEvaluationResponse(BaseModel):
    protocol: str
    duration_s: float
    qoe_score: float = Field(..., description="Puntuación global de QoE en escala [0, 5]")
    vmaf_mean: float = Field(..., description="VMAF medio de la sesión en escala [0, 100]")
    total_freeze_s: float
    stalls_count: int
    avg_latency_s: float
    avg_speed: float
    penalties: QoEPenalties
    timeline: List[QoESecondTimeline]


def estimate_rendition_vmaf(height: int) -> float:
    """Estima el VMAF nominal de compresión según la resolución de la escalera codificada con x264 ultrafast."""
    if height >= 1080:
        return 93.5
    elif height >= 720:
        return 83.0
    elif height >= 480:
        return 74.5
    elif height >= 360:
        return 67.0
    else:
        return 55.0


def calculate_ll_gabr_qoe(req: QoEEvaluationRequest) -> QoEEvaluationResponse:
    """Calcula la métrica de QoE discretizando en ventanas de 1 segundo de reloj del espectador."""
    duration_s = max(1.0, req.duration_s)
    T = int(math.ceil(duration_s))

    # Determinar el instante de inicio de la prueba (t=0)
    all_times = [f.wall_time_ms for f in req.frames]
    if req.stalls:
        all_times.extend([s.start_wall_time_ms for s in req.stalls])
    t0 = min(all_times) if all_times else 0.0

    # Agrupar frames y parones por segundo de reloj del espectador
    timeline: List[QoESecondTimeline] = []
    prev_vmaf = None

    total_freeze_sec = 0.0
    total_stalls_count = len(req.stalls)

    # Factor de escala de alpha para normalizar a la duración de la prueba
    # En LL-GABR con T=300, alpha=0.077 da un aporte máximo de ~115.5.
    # Normalizamos para que la calidad visual máxima represente una base de 5.0 puntos en cualquier duración T.
    alpha_adjusted = 5.0 / T

    for sec in range(1, T + 1):
        sec_start_ms = t0 + (sec - 1) * 1000.0
        sec_end_ms = t0 + sec * 1000.0

        # Frames en este segundo de reloj
        sec_frames = [f for f in req.frames if sec_start_ms <= f.wall_time_ms < sec_end_ms]

        # Calcular solapamiento con eventos de congelación
        freeze_ms_in_sec = 0.0
        stalls_started_in_sec = 0
        for stall in req.stalls:
            stall_start = stall.start_wall_time_ms
            stall_end = stall.start_wall_time_ms + stall.duration_ms
            overlap_start = max(sec_start_ms, stall_start)
            overlap_end = min(sec_end_ms, stall_end)
            if overlap_end > overlap_start:
                freeze_ms_in_sec += (overlap_end - overlap_start)
            # ¿El stall comenzó en este segundo?
            if sec_start_ms <= stall_start < sec_end_ms:
                stalls_started_in_sec += 1

        freeze_s = min(1.0, freeze_ms_in_sec / 1000.0)
        total_freeze_sec += freeze_s

        if sec_frames:
            # Calidad visual media de los fotogramas mostrados
            heights = [f.rendition_height for f in sec_frames]
            rep_height = max(set(heights), key=heights.count)
            vmaf = sum(estimate_rendition_vmaf(f.rendition_height) for f in sec_frames) / len(sec_frames)
            latency_s = max(0.0, sum(f.latency_ms for f in sec_frames) / (len(sec_frames) * 1000.0))
            speed = sum(f.playback_rate for f in sec_frames) / len(sec_frames)
            frames_count = len(sec_frames)
        else:
            # Segundo completamente congelado
            rep_height = timeline[-1].rendition_height if timeline else 1080
            vmaf = timeline[-1].vmaf if timeline else estimate_rendition_vmaf(rep_height)
            latency_s = (timeline[-1].latency_s + 1.0) if timeline else 1.0
            speed = 0.0
            frames_count = 0

        delta_vmaf = abs(vmaf - prev_vmaf) if prev_vmaf is not None else 0.0
        prev_vmaf = vmaf

        timeline.append(
            QoESecondTimeline(
                sec=sec,
                vmaf=round(vmaf, 2),
                freeze_s=round(freeze_s, 3),
                stalls_count=stalls_started_in_sec,
                latency_s=round(latency_s, 3),
                speed=round(speed, 2),
                delta_vmaf=round(delta_vmaf, 2),
                frames_count=frames_count,
                rendition_height=rep_height,
            )
        )

    # Medias y agregados de la sesión
    vmaf_mean = sum(s.vmaf for s in timeline) / T
    avg_latency_s = sum(s.latency_s for s in timeline) / T
    avg_speed = sum(s.speed for s in timeline) / T

    # Cálculo de los 5 componentes de la ecuación de LL-GABR:
    # 1. Calidad visual
    visual_score = alpha_adjusted * sum(s.vmaf / 20.0 for s in timeline)

    # 2. Penalización por congelaciones
    freeze_pen = BETA_STALL * total_freeze_sec
    stall_count_pen = GAMMA_STALL * total_stalls_count

    # 3. Penalización por latencia
    latency_pen = SIGMA_LATENCY * avg_latency_s

    # 4. Penalización por aceleración catch-up (|1 - s|)
    catchup_pen = MU_SPEED * abs(1.0 - avg_speed)

    # 5. Penalización por inestabilidad de calidad (|ΔVMAF| / 20)
    smoothness_pen = (OMEGA_SMOOTH / max(1, T - 1)) * sum(s.delta_vmaf / 20.0 for s in timeline[1:])

    # Puntuación global QoE en escala 0 a 5
    raw_qoe = visual_score - freeze_pen - stall_count_pen - latency_pen - catchup_pen - smoothness_pen
    qoe_score = max(0.0, min(5.0, raw_qoe))

    penalties = QoEPenalties(
        visual_quality_score=round(visual_score, 3),
        freeze_penalty=round(freeze_pen, 3),
        stall_count_penalty=round(stall_count_pen, 3),
        latency_penalty=round(latency_pen, 3),
        catchup_penalty=round(catchup_pen, 3),
        smoothness_penalty=round(smoothness_pen, 3),
    )

    return QoEEvaluationResponse(
        protocol=req.protocol,
        duration_s=round(duration_s, 1),
        qoe_score=round(qoe_score, 2),
        vmaf_mean=round(vmaf_mean, 2),
        total_freeze_s=round(total_freeze_sec, 2),
        stalls_count=total_stalls_count,
        avg_latency_s=round(avg_latency_s, 3),
        avg_speed=round(avg_speed, 2),
        penalties=penalties,
        timeline=timeline,
    )
