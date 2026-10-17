package kernel

import (
	"context"
	"errors"
)

// ErrInvalidLayout means the compiler supplied inconsistent kernel instructions.
// The generated-contract adapter validates the saved semantics-3 graph before it
// builds these instructions; this error is not a domain-validation substitute.
var ErrInvalidLayout = errors.New("invalid compiled workflow layout")

// Action is one graph wrapper, including a wrapper that resolves as skipped or
// finds an already-resolved slot. The wrapper owns admission, exact execution
// observation and the shared ExecutionLimiter. The scheduler acquires no slot.
type Action func(context.Context) error

// BoundaryRoute is internal control flow after the store has entered or advanced
// a repeat block. It carries neither an occurrence nor a decision receipt.
type BoundaryRoute uint8

const (
	RepeatBody BoundaryRoute = iota + 1
	RepeatDone
)

type BoundaryAction func(context.Context) (BoundaryRoute, error)

// Step is an opaque instruction handle, valid only in its creating Builder.
// It is not a workflow node ID, execution identity or durable checkpoint key.
type Step struct {
	builder *Builder
	index   int
}

// RepeatBoundary exposes only the block's external ingress and egress. Body
// wrappers cannot satisfy an outside dependency, even on an intermediate exit.
type RepeatBoundary struct {
	Enter Step
	Done  Step
}

type instruction struct {
	action   Action
	boundary BoundaryAction
	body     int
	done     int
}

type repeatRegion struct {
	entry   int
	exit    int
	enter   int
	advance int
	done    int
}

// Builder holds compiler-owned instructions and all-source barriers. It accepts
// callbacks and handles, not copies of WorkflowDefinition or resolution DTOs.
// Add nodes in the validated topology's stable order. Builder is not concurrent.
type Builder struct {
	steps    []instruction
	incoming [][]int
	repeats  []repeatRegion
}

func (b *Builder) Add(action Action) (Step, error) {
	if action == nil {
		return Step{}, ErrInvalidLayout
	}
	return b.append(instruction{action: action}), nil
}

func (b *Builder) append(value instruction) Step {
	step := Step{builder: b, index: len(b.steps)}
	b.steps = append(b.steps, value)
	b.incoming = append(b.incoming, nil)
	return step
}

func (b *Builder) owns(step Step) bool {
	return step.builder == b && step.index >= 0 && step.index < len(b.steps)
}

// DependsOn merges sources into one barrier. Repeated relationships from the
// same source count once, as in compileRepeatLayout. All sources must return
// successfully before target is scheduled; a skipped wrapper still returns.
func (b *Builder) DependsOn(target Step, sources ...Step) error {
	if !b.owns(target) || len(sources) == 0 {
		return ErrInvalidLayout
	}
	for _, source := range sources {
		if !b.owns(source) || source == target {
			return ErrInvalidLayout
		}
	}
	for _, source := range sources {
		if !containsStep(b.incoming[target.index], source.index) {
			b.incoming[target.index] = append(b.incoming[target.index], source.index)
		}
	}
	return nil
}

// Repeat adds exactly three static instructions around an existing body DAG.
// Enter chooses body or done; every accepted body exit reaches Advance, whose
// store-backed callback makes the same choice. Occurrence caps and identities
// stay in those callbacks. There is no occurrence-sized unroll or sub-scheduler.
func (b *Builder) Repeat(entry, exit Step, enter, advance BoundaryAction) (RepeatBoundary, error) {
	if !b.owns(entry) || !b.owns(exit) || enter == nil || advance == nil {
		return RepeatBoundary{}, ErrInvalidLayout
	}
	enterStep := b.append(instruction{boundary: enter, body: entry.index})
	advanceStep := b.append(instruction{boundary: advance, body: entry.index})
	doneStep := b.append(instruction{action: func(context.Context) error { return nil }})
	b.steps[enterStep.index].done = doneStep.index
	b.steps[advanceStep.index].done = doneStep.index
	b.incoming[advanceStep.index] = []int{exit.index}
	b.repeats = append(b.repeats, repeatRegion{entry: entry.index, exit: exit.index,
		enter: enterStep.index, advance: advanceStep.index, done: doneStep.index})
	return RepeatBoundary{Enter: enterStep, Done: doneStep}, nil
}

type barrier struct {
	sources []int
	target  int
}

// Program is an immutable, static instruction layout. It contains no Run data,
// accepted facts, persistence hooks or permission claims. A generated adapter
// binds the exact scoped store and driver in each callback before invocation.
type Program struct {
	steps          []instruction
	barriers       []barrier
	outgoing       [][]int
	start          int
	recursionLimit int
}

// Compile requires the explicit superstep budget derived by the existing V3
// compiler. It adds no default, occurrence limit or native execution budget.
// Only Repeat's guarded boundary routes may cycle. Body ingress/egress is sealed
// so that external dependencies can observe only the block's Done instruction.
func (b *Builder) Compile(start Step, recursionLimit int) (*Program, error) {
	if !b.owns(start) || recursionLimit < 1 || int64(recursionLimit) > maximumSafeInteger {
		return nil, ErrInvalidLayout
	}
	outgoing := make([][]int, len(b.steps))
	for target, sources := range b.incoming {
		for _, source := range sources {
			outgoing[source] = append(outgoing[source], target)
		}
	}
	if len(b.incoming[start.index]) != 0 || !b.acyclic(outgoing) || !b.sealedRepeats(outgoing) {
		return nil, ErrInvalidLayout
	}
	for _, region := range b.repeats {
		if start.index == region.entry || start.index == region.done {
			return nil, ErrInvalidLayout
		}
	}
	if !b.reachable(start.index, outgoing) {
		return nil, ErrInvalidLayout
	}
	program := &Program{steps: append([]instruction(nil), b.steps...), start: start.index,
		recursionLimit: recursionLimit, outgoing: make([][]int, len(b.steps))}
	for target, sources := range b.incoming {
		if len(sources) == 0 {
			continue
		}
		index := len(program.barriers)
		program.barriers = append(program.barriers, barrier{sources: append([]int(nil), sources...), target: target})
		for _, source := range sources {
			program.outgoing[source] = append(program.outgoing[source], index)
		}
	}
	return program, nil
}

func (b *Builder) acyclic(outgoing [][]int) bool {
	// Include the forward routes through each block. Only advance -> body is a
	// permitted back edge; ignoring all boundary routes would hide outer cycles
	// such as first.done -> second.enter -> second.done -> first.enter.
	edges := make([][]int, len(outgoing))
	for step := range outgoing {
		edges[step] = append([]int(nil), outgoing[step]...)
	}
	for _, region := range b.repeats {
		edges[region.enter] = append(edges[region.enter], region.entry, region.done)
		edges[region.advance] = append(edges[region.advance], region.done)
	}
	remaining := make([]int, len(b.steps))
	queue := make([]int, 0, len(b.steps))
	for _, targets := range edges {
		for _, target := range targets {
			remaining[target]++
		}
	}
	for step, count := range remaining {
		if count == 0 {
			queue = append(queue, step)
		}
	}
	for head := 0; head < len(queue); head++ {
		for _, target := range edges[queue[head]] {
			remaining[target]--
			if remaining[target] == 0 {
				queue = append(queue, target)
			}
		}
	}
	return len(queue) == len(b.steps)
}

func (b *Builder) sealedRepeats(outgoing [][]int) bool {
	claimed := make([]bool, len(b.steps))
	control := make([]bool, len(b.steps))
	for _, region := range b.repeats {
		control[region.enter], control[region.advance], control[region.done] = true, true, true
	}
	for _, region := range b.repeats {
		if len(outgoing[region.enter]) != 0 || len(outgoing[region.advance]) != 0 || len(b.incoming[region.done]) != 0 {
			return false
		}
		if len(b.incoming[region.advance]) != 1 || b.incoming[region.advance][0] != region.exit {
			return false
		}
		forward := reachableSteps(region.entry, outgoing)
		backward := reachableSteps(region.exit, b.incoming)
		if !forward[region.exit] {
			return false
		}
		members := make([]bool, len(b.steps))
		for step := range b.steps {
			members[step] = forward[step] && backward[step]
			if members[step] {
				if claimed[step] || control[step] {
					return false
				}
				claimed[step] = true
			}
		}
		for target, sources := range b.incoming {
			for _, source := range sources {
				if members[target] && !members[source] {
					return false
				}
				if members[source] && !members[target] && !(source == region.exit && target == region.advance) {
					return false
				}
			}
		}
	}
	return true
}

func (b *Builder) reachable(start int, outgoing [][]int) bool {
	edges := make([][]int, len(outgoing))
	for step := range outgoing {
		edges[step] = append([]int(nil), outgoing[step]...)
		if b.steps[step].boundary != nil {
			edges[step] = append(edges[step], b.steps[step].body, b.steps[step].done)
		}
	}
	for _, seen := range reachableSteps(start, edges) {
		if !seen {
			return false
		}
	}
	return true
}

func reachableSteps(start int, outgoing [][]int) []bool {
	seen := make([]bool, len(outgoing))
	queue := []int{start}
	seen[start] = true
	for head := 0; head < len(queue); head++ {
		for _, target := range outgoing[queue[head]] {
			if !seen[target] {
				seen[target] = true
				queue = append(queue, target)
			}
		}
	}
	return seen
}

func containsStep(steps []int, wanted int) bool {
	for _, step := range steps {
		if step == wanted {
			return true
		}
	}
	return false
}

// Size reports static instructions and barriers, independent of the occurrence
// count or recursion budget. It is scheduler diagnostics, not a Run graph read.
func (p *Program) Size() (steps, barriers int) {
	return len(p.steps), len(p.barriers)
}
