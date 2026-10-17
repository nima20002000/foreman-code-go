# Run execution capacity

`ExecutionLimiter` ports the FIFO, Run-local gate from the frozen
`apps/api/src/modules/runs/limiter.ts`. Construct one instance for a Run and
pass it to graph, interval and Job work. Pass the existing configured limits
explicitly; this package introduces no new default or capacity policy.

`Run(ctx, work, queued)` preserves the callback's result or error, rejects
overflow with `RUNNER_ADMISSION_FULL`, withdraws canceled waits, checks
cancellation again immediately before work, and transfers an occupied slot
directly to the oldest waiter. A running callback retains its slot until it
returns, even if its context is canceled. Work must observe the context it
received through its closure.

The optional `QueueWait` callback is the internal boundary for the existing
process-local execution queue reason. It is called only when a wait is
admitted and returns cleanup for that observation. A generated-contract
adapter can bind the exact execution identity and publish
`workflow_parallelism` there, as `executionQueue.ts` does. Observation cleanup
completes before native work starts. The kernel does not define Run,
HarnessExecution, queue-reason or permission DTOs.

The scheduler must not acquire a slot around a callback which already calls
this limiter. The frozen `repeatNode.ts` also re-observes an already-completed
attempt for SQL/cleanup-only settlement without acquiring native launch
capacity; domain composition must retain that distinction.

This initial increment supplies only the limiter and public-method behavior
tests. The compiled scheduler, generated-type compiler adapter, persistence,
ownership fences and retry policy are separate unfinished work. No route or
MCP capability is added by this increment.

Tests are authored and unrun. Formatting, build, lint and test execution must
be dispatched by the terminal through Foreman CI MCP, scoped to this package.
