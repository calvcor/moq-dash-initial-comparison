# Por qué usamos la rama principal de moq en lugar de sus versiones publicadas

El banco de pruebas usa el publicador y el reproductor de MoQ compilados desde un commit de la rama `main` del proyecto [moq-dev/moq](https://github.com/moq-dev/moq) (`bc64b9c`, del 21 de octubre de 2026), en vez de las versiones publicadas. El motivo principal es que las versiones publicadas medidas tienen un límite de rendimiento en el publicador que contaminaba toda medida de MoQ, y que `main` ya no tiene. Este documento recoge las medidas que llevaron a esa decisión, lo que implica para la tesis y cuándo habría que revisarla.

## Qué componente usa qué versión

No todos los componentes de moq-dev vienen de `main`. El relay sigue siendo una versión publicada.

| Componente | Versión desplegada (30-10-2026) | Desde | Dónde se elige |
| :--- | :--- | :--- | :--- |
| Publicador (`moq-cli`) | `main`, `git@bc64b9c` | 21-10-2026 | `MOQ_CLI_FROM=git` en el `.env`; commit en `MOQ_CLI_COMMIT` |
| Reproductor (`@moq/watch` y sus diez paquetes `@moq/*`) | `main`, `git@bc64b9c+switching` | 22-10-2026 (el parche, 23-10-2026) | `MOQ_WATCH_FROM=git` en el `.env`; commit en `MOQ_WATCH_COMMIT` |
| Relay (`moq-relay`) | Publicada, 0.17.9 | 29-10-2026 | `MOQ_RELAY_VERSION` en `docker-compose.yml` |

El relay no se ha medido compilado desde `main`: ningún problema de los encontrados apuntaba a él, así que no hubo motivo para cambiarlo. Publicador y relay negocian `moq-lite-06` (comprobado en el registro del relay).

## Motivo 1: el publicador publicado no pasa de unos 2 MB/s de entrada

Este es el motivo decisivo.

**Cómo se llegó aquí.** Con varias calidades, el reproductor de MoQ cambiaba de calidad continuamente sin que la red tuviera nada que ver, y aparecían esperas de hasta 1-2 s en la entrada del publicador. Tras descartar la fuente, la falta de CPU de la máquina y el relay, se localizó en `moq-cli`: procesa su entrada a un máximo de unos 2 MB/s, con unos 0,3 µs de CPU por byte, casi todos en el núcleo. Ocurre igual sin espectadores, con cualquier control de congestión, con 1 o 2 hilos de tokio y con H.264 crudo en vez de MPEG-TS, así que no es la red ni el demultiplexor (PROTOCOLOS, 4.14).

**Qué efecto tiene.** Un keyframe de unos 100 kB tarda unos 50 ms en entrar, y los frames siguientes esperan detrás. Con la escalera de tres calidades, los keyframes coinciden y el publicador se satura. Esa cola se suma a la latencia de MoQ y, a través de las marcas `stalled` del catálogo, provoca la mayoría de los cambios de calidad.

**La diferencia está en el código, no en cómo se compila.** La 0.14.7 compilada con los mismos ajustes que `main` (LTO *thin*, solo QUIC) rinde igual que la publicada.

| Medida | `moq-cli` 0.14.7 | `main` (`bc64b9c`) | Dónde |
| :--- | :--- | :--- | :--- |
| Lectura de la entrada, sin ritmo real | 1,9-2,0 MB/s | 200-730 MB/s | Local |
| Espera de un keyframe en la entrada, con un espectador | 32-55 ms de mediana | 0,2-0,3 ms | Local |
| Escalera de tres calidades, 40 s: cambios de calidad | 92-140 | 0 | Local |
| Escalera de tres calidades, 40 s: huecos de entrega | Espera p95 de 117-146 ms | Ninguno | Local |
| Escalera 2000/1000/350, 40 s: espera p95 en la entrada | 1,2 y 3,5 s | 1 ms (máximo 12 ms) | Servidor |
| Escalera 2000/1000/350, 40 s: cambios de calidad | 34 y 54 | 0 | Servidor |
| Escalera 2000/1000/350, 40 s: frames pintados | 47-56 fps | 57-59 fps | Servidor |

Medido el 21 de octubre de 2026, alternando las variantes y comprobando qué binario corría en cada pasada. En el servidor, dos pasadas de 40 s por variante con un espectador de MoQ.

**Por qué importa para la tesis.** Con la versión publicada, lo que se medía en MoQ con varias calidades era sobre todo la cola de un programa saturado: no decía nada del protocolo ni de su mecanismo de adaptación, y la comparación con DASH y WebRTC quedaba dominada por un defecto ajeno a lo que se quiere estudiar.

## Motivo 2: la inestabilidad de las versiones publicadas

Las versiones publicadas de esos días no eran una base estable sobre la que medir (medido en el servidor, con el relay y las condiciones de cada momento):

| Versión de `moq-cli` | Comportamiento medido |
| :--- | :--- |
| 0.14.4 | Lee su entrada más despacio que el ritmo de la fuente y acumula retraso sin parar: 16-18 s de espera al minuto y medio. MoQ deja de reproducir |
| 0.14.5 | Aguanta sin espectadores, pero se queda atrás con uno. Con tres calidades, 3 s de espera mediana y MoQ a 2 s de latencia; con una, 49 congelados en 85 s frente a 13 con 0.14.3 |
| 0.14.7 | Sin ese retraso creciente, pero con el límite de ~2 MB/s del motivo 1 |

Este motivo es secundario: por sí solo se habría resuelto quedándose en una versión concreta. Las notas de las publicadas después (0.14.8 y 0.14.10) describen sobre todo retroportes de correcciones a la rama de publicación, y no mencionan el rendimiento de la entrada. **No se han medido**, así que no se sabe si alguna ha resuelto el límite.

## Motivo 3: el reproductor de `main` hace cosas que el publicado no hace

El reproductor pasó a `main` un día después que el publicador. Aquí no había un fallo que evitar, y el commit del cambio (`c52bb4b`) no da más motivo que usar el mismo commit que el publicador, como ya se hacía en local. Lo que sigue es lo que se midió justo antes de ese cambio y lo que distingue a las dos versiones; la relación con la decisión es una reconstrucción.

**El modo automático se adapta durante la sesión.** En la 0.6.3, el búfer automático se calcula con el RTT y queda fijo. En `main` se usa un estimador tomado de NetEq (percentil 95 de lo tarde que llegan los frames), que sube al empeorar la red y baja al estabilizarse. Medido el 22 de octubre de 2026 en local, en la misma sesión y alternando dos veces:

| Condición de red | 0.6.3: objetivo / latencia / pintados | `main`: objetivo / latencia / pintados |
| :--- | :--- | :--- |
| Sin restricciones | 88 ms / 116-123 ms / 60 fps | 20 ms / 49-59 ms / 54-60 fps |
| 150 ms por sentido | 88 ms / 189-265 ms / 60 fps | 160 ms / 342-348 ms / 58-60 fps |
| 150 ms y 1 % de pérdida | 88 ms / 264-271 ms / 24-28 fps | 340 ms / 514-524 ms / 47-60 fps |

No es una mejora sin más: con retardo y pérdida, `main` sacrifica latencia a cambio de fluidez. Y como mide jitter y no latencia, ante un salto brusco de retardo pasa unos 20 s con un búfer de más (PROTOCOLOS, 4.11).

**La selección de calidad ya no usa `stalled`.** En `main` ese campo ni siquiera está en el esquema del catálogo; la selección usa `enabled`, `preference` y la regla de caudal con el margen del 80 % (leído del código; PROTOCOLOS, 4.10). Era el mecanismo que convertía la irregularidad del publicador en cambios continuos de calidad.

**Coherencia entre las dos piezas.** Publicador y reproductor salen del mismo commit, de modo que el catálogo que escribe uno es el que espera el otro.

## Motivo 4: permite experimentos con el reproductor

Tener el reproductor compilado desde el código permite aplicar parches declarados, como la opción `switching` del experimento de cambio de calidad (README, 6.1). Es una consecuencia, no la causa de la decisión. Con su valor por defecto (`seamless`) se comporta como sin parche, y la versión se identifica como `git@bc64b9c+switching`.

## Lo que implica y hay que declarar

**Es una elección que favorece a MoQ, y hay que decirlo.** El principio del banco de pruebas es medir las implementaciones como vienen, sin hacerlas funcionar bien. El código de `main` se usa sin modificar (salvo el parche anterior, inactivo por defecto), así que el principio se respeta. Pero se ha elegido una versión sin publicar precisamente porque rinde mejor, y eso no se ha hecho con `dash.js` ni con el WebRTC del navegador, que van en versiones publicadas. La justificación es que el límite de 2 MB/s es un defecto de la implementación y no una propiedad de MoQ, pero un lector puede preferir también la cifra con la versión publicada. Por eso la opción sigue disponible (`MOQ_CLI_FROM=release`).

**Lo medido no es lo que obtendría quien instale hoy la versión publicada.** Las conclusiones sobre MoQ valen para el commit `bc64b9c`, y hay que citarlo.

**Las medidas de antes y de después no son comparables.** Publicador: frontera en el 21-10-2026. Reproductor en el servidor: frontera en el 22-10-2026. El panel y la columna `versions` del CSV identifican cada una.

**`main` es un blanco móvil, por eso se fija un commit.** Nunca se usa "lo último de `main`": el commit está escrito en los Dockerfile y solo cambia a propósito. Si se cambia, el parche `switching` hay que rehacerlo; la construcción falla si no aplica.

**Tiene costes prácticos:**

- Compilar `moq-cli` tardó 12,5 min en el servidor y necesita varios GB de RAM (LTO *thin* y solo QUIC, porque el LTO completo no cupo en 7,7 GB). Con caché no se repite.
- `moq --version` dice 0.14.2 aunque el código no es esa versión. La identidad fiable es la etiqueta `git@<commit>` del panel y del CSV.
- El panel no compara estas piezas con la última versión publicada, así que no avisa de novedades en ellas.
- El relay es de la línea publicada y el publicador de `main`. Funcionan juntos, pero es una combinación que el proyecto no publica como tal.

## Cuándo revisar esta decisión

1. **Cuando una versión publicada traiga el arreglo.** Mídela con el procedimiento de CLAUDE.md (entrada del publicador con un espectador conectado) y, si se confirma, vuelve a una versión publicada: es más fácil de citar y de reproducir.
2. **Antes de publicar resultados.** Conviene repetir al menos una condición de control con la última versión publicada, para poder decir cuánto depende el resultado de esta elección. Las versiones publicadas posteriores a la 0.14.7 no se han medido.

## Dónde está el detalle

| Tema | Dónde |
| :--- | :--- |
| Cómo compilar desde un commit | README, 4.4b |
| El límite de entrada del publicador | PROTOCOLOS, 4.14 y final de 4.10 |
| El estimador del modo automático | PROTOCOLOS, 4.11 |
| La selección de calidad en la versión desplegada | PROTOCOLOS, 4.10 |
| El parche `switching` | README, 6.1 |
| Fechas de cada cambio de versión | Nota de versiones al principio de PROTOCOLOS |
| Commits con las medidas | `91cd653`, `0314981` (publicador); `7fea938`, `c52bb4b` (reproductor); `4a7cf3a` (selección de calidad) |
