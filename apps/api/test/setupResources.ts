import { ownedTestDatabaseUrl } from './helpers/testResources.js'
import { installTestConnectionGuard } from '../../../scripts/test-postgres-guard.mjs'

ownedTestDatabaseUrl()
installTestConnectionGuard()
