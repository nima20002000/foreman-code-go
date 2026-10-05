import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Socket } from 'node:net'

import { LocalHumanAccessSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { localHumanClient } from '@foreman-code/contracts/local-client-node'
