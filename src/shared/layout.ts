export const layout = { request: 300, canvas: 480, sidebar: 220, toolbar: 54, status: 30, results: 132, canvasHeight: 330, divider: 5 };
export const minimum = (sidebar: boolean) => ({ width: layout.request + layout.canvas + layout.divider + (sidebar ? layout.sidebar + layout.divider : 0), height: layout.toolbar + layout.status + layout.results + layout.canvasHeight });
