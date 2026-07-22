export type Renderer = (
  template: string,
  data?: Record<string, unknown>,
) => Promise<Response>

declare module 'hono' {
  interface ContextVariableMap {
    render: Renderer
  }
}
