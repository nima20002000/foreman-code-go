import { ownedTestDatabaseUrl } from './helpers/testResources.js'
import { installTestConnectionGuard } from '../../../scripts/test-postgres-guard.mjs'
import { recordIntegrationStartup } from '../../../scripts/integration-startup.mjs'

ownedTestDatabaseUrl()
installTestConnectionGuard()
recordIntegrationStartup('worker-setup')
