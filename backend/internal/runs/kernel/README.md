# Run execution kernel

`ExecutionLimiter` ports the FIFO, Run-local gate from the frozen
`apps/api/src/modules/runs/limiter.ts`. Construct one instance for a Run and
pass it to graph Agent and Job work. Interval checks observe their native driver
without graph-parallelism slots, as `startIntervalChecks` does. Pass the existing
configured limits explicitly; this package introduces no new default or capacity
policy and implements no interval scheduling.

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

## Compiled instruction scheduling

`Builder` accepts opaque instruction handles and wrapper callbacks. `DependsOn`
collects all predecessor wrappers into one barrier, including wrappers whose
store admission resolves them as skipped. Duplicate sources count once. The
generated compiler must validate the saved semantics-3 graph, exclude unreachable
authored components and add its reachable wrappers in stable topology order.
This package does not define or parse WorkflowDefinition, WorkflowVersion,
NodeResolution, occurrence, execution or checkpoint DTOs.

`Repeat` seals a body DAG behind three control instructions: enter, advance and
done. Enter and advance callbacks return `RepeatBody` or `RepeatDone` after their
scoped store operation. Body entry and exit handles refer to the same static
wrappers on every occurrence. Only the returned `Done` handle can supply an
outside dependency; an intermediate body exit cannot select or deselect one.
Compilation rejects direct body ingress/egress, overlapping bodies and authored
cycles. There is one scheduler and no per-occurrence graph allocation.

`Compile` takes the existing compiler's explicit superstep budget; it introduces
no default or occurrence cap. For the frozen repeat layout that budget is two,
plus one per outside wrapper, plus `2 + maxOccurrences * (bodyNodeCount + 1)`
per block. Occurrence identity, accepted results, carry and the actual repeat
limit remain store responsibilities. `Program.Size` reports only static
instruction and barrier counts. Compiling or starting a program does not allocate
storage proportional to that budget.

`Program.Start(ctx)` runs ready wrappers concurrently in supersteps. It publishes
completion into barriers only after the whole successful superstep settles.
Missing predecessors never become unselected edges. Enter/advance decisions route
to body or done; normal skipped wrappers still fire their dependency barriers.
The scheduler never acquires `ExecutionLimiter` around a callback. In particular,
an already-completed attempt's SQL/cleanup-only observation can finish while
native capacity is occupied. The generated execution adapter must keep the
frozen `admit`/`observe`/`acceptTerminal` distinction and must not relaunch an
already-completed attempt. These callbacks are execution ports, not new launch
authority or fake evidence of acceptance.

`Invocation.Wait` joins one settled success, wrapper error or original cancellation
cause. Cancellation participates until settlement, independently of callback
drain. Later cancellation cannot replace a stored outcome, and repeated waits
return that same outcome. The owner retains the invocation and calls
`Drain` with its existing cleanup context before releasing ownership. Running
callbacks retain their context and limiter slot until they return. The kernel
does not classify arbitrary errors as Stop, cancel healthy siblings, choose a
cleanup deadline or certify native closure. Those operations remain in the
owning runtime's existing failure and cleanup path.

This increment has no durable checkpoint, retry, resume, lease or fencing
implementation. Starting another invocation is not durable recovery. Its
callbacks must re-read exact durable slots before observing existing attempts.
Generated-contract compiler adapters and production composition remain blocked
on the shared export; no route or MCP capability is introduced here.

### Frozen behavior sources

All sources are from the fork at the frozen TypeScript commit
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`:

- [Static repeat layout, ingress/egress and recursion budget](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/runs/repeatResolution.ts).
- [Graph compilation, wrapper invocation and boundary routing](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/runs/repeatGraph.ts).
- [All-incoming settlement before admission](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/runs/topology.ts).
- [Completed-attempt settlement and callback-owned limiter](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/runs/repeatNode.ts).
- [Invocation cancellation race and retained wrapper drain](https://github.com/nima20002000/foreman-code-go/blob/8d2ea76c5028ef4458bf8cd64ef8624422e71d9f/apps/api/src/modules/runs/repeatRuntime.ts).

Tests are authored and unrun. Formatting, build, lint and test execution must
be dispatched by the terminal through Foreman CI MCP, scoped to this package.
