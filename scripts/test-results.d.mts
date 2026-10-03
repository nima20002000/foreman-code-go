export function vitestResultOptions(): {
  reporters?: Array<'default' | 'github-actions' | 'json'>
  outputFile?: { json: string }
}
