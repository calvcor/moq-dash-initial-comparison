/** Columnas según cuántos reproductores hay activos: con uno, centrado y no a todo el ancho. */
export const gridCols = (active: Record<string, boolean>) =>
  ['grid-cols-1 max-w-3xl mx-auto w-full', 'grid-cols-1 max-w-3xl mx-auto w-full', 'grid-cols-2', 'grid-cols-3'][
    Object.values(active).filter(Boolean).length
  ];
