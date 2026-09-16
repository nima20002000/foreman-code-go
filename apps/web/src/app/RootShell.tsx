import { Outlet } from '@tanstack/react-router'

import { OperatorChat } from '../features/operator-chat'

export function RootShell() { return <><Outlet /><OperatorChat /></> }
