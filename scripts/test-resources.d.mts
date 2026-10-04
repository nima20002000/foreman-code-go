export interface TestRoot { directory: string; token: string }
export interface TestDatabase extends TestRoot { name: string; databaseUrl: string }
interface Sql {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}
export const testAdminUrl: string
export function requireTestServerUrl(value: string): URL
export function createTestRoot(parent?: string, prefix?: string): TestRoot
export function assertTestRoot(directory: string, token: string): void
export function assertTestPath(resource: TestRoot, path: string): string
export function removeTestRoot(resource: TestRoot): void
export function testEnvironment(environment: NodeJS.ProcessEnv, resource: TestDatabase): NodeJS.ProcessEnv
export function provisionTestResources(environment?: NodeJS.ProcessEnv): Promise<{
  environment: NodeJS.ProcessEnv
  close(): Promise<void>
}>
export function createTestDatabase(admin: Sql, resource: TestRoot): Promise<TestDatabase>
export function assertTestDatabase(admin: Sql, resource: TestDatabase): Promise<void>
export function dropTestDatabase(admin: Sql, resource: TestDatabase): Promise<void>
export function ownedTestDatabaseUrl(variable?: string): string
export function createFixtureDatabase(sql: Sql, name: string, options?: string): Promise<void>
export function dropFixtureDatabase(sql: Sql, name: string): Promise<void>
export function createFixtureSchema(sql: Sql, name: string): Promise<void>
export function dropFixtureSchema(sql: Sql, name: string): Promise<void>
export function removeFixtureDirectory(directory: string, options?: { force: boolean }): Promise<void>
export function ownedTestPath(path: string): string
