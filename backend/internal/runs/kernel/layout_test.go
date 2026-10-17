package kernel_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/kernel"
)

func TestLayoutDeduplicatesBarriersAndFreezesCompiledInstructions(t *testing.T) {
	var builder kernel.Builder
	var calls atomic.Int32
	action := func(context.Context) error { calls.Add(1); return nil }
	start := addStep(t, &builder, action)
	left := addStep(t, &builder, action)
	right := addStep(t, &builder, action)
	join := addStep(t, &builder, action)
	depend(t, &builder, left, start)
	depend(t, &builder, right, start)
	depend(t, &builder, join, left, left, right)
	depend(t, &builder, join, right)
	program := compileProgram(t, &builder, start, 10)
	if steps, barriers := program.Size(); steps != 4 || barriers != 3 {
		t.Fatalf("compiled size = %d steps, %d barriers; want 4, 3", steps, barriers)
	}
	// Later compiler mutation must not turn the retained program into a cycle or
	// introduce a callback that was absent from its immutable instructions.
	depend(t, &builder, start, join)
	addStep(t, &builder, func(context.Context) error { return errors.New("late compiler callback ran") })
	finishInvocation(t, program.Start(context.Background()), nil)
	if calls.Load() != 4 {
		t.Fatalf("wrapper calls = %d; want 4", calls.Load())
	}
}

func TestLayoutRejectsForeignHandlesAndAuthoredCycles(t *testing.T) {
	var builder, foreign kernel.Builder
	a := addStep(t, &builder, noWork)
	b := addStep(t, &builder, noWork)
	other := addStep(t, &foreign, noWork)
	for _, sources := range [][]kernel.Step{{}, {a}, {other}, {{}}} {
		if err := builder.DependsOn(a, sources...); !errors.Is(err, kernel.ErrInvalidLayout) {
			t.Fatalf("invalid dependency accepted: %v", err)
		}
	}
	if err := builder.DependsOn(other, a); !errors.Is(err, kernel.ErrInvalidLayout) {
		t.Fatalf("foreign target accepted: %v", err)
	}
	if _, err := builder.Add(nil); !errors.Is(err, kernel.ErrInvalidLayout) {
		t.Fatalf("nil callback accepted: %v", err)
	}
	depend(t, &builder, b, a)
	depend(t, &builder, a, b)
	if _, err := builder.Compile(a, 10); !errors.Is(err, kernel.ErrInvalidLayout) {
		t.Fatalf("authored cycle accepted: %v", err)
	}
}

func TestLayoutRequiresValidCompiledReachabilityAndBudget(t *testing.T) {
	var builder kernel.Builder
	start := addStep(t, &builder, noWork)
	for _, budget := range []int{0, -1} {
		if _, err := builder.Compile(start, budget); !errors.Is(err, kernel.ErrInvalidLayout) {
			t.Fatalf("invalid explicit budget %d accepted: %v", budget, err)
		}
	}
	if _, err := builder.Compile(kernel.Step{}, 10); !errors.Is(err, kernel.ErrInvalidLayout) {
		t.Fatalf("missing start accepted: %v", err)
	}
	addStep(t, &builder, noWork)
	if _, err := builder.Compile(start, 10); !errors.Is(err, kernel.ErrInvalidLayout) {
		t.Fatalf("orphan compiled wrapper accepted: %v", err)
	}
}

func TestLayoutSealsRepeatBodyIngressAndEgress(t *testing.T) {
	cases := []struct {
		name   string
		change func(*testing.T, *kernel.Builder, kernel.Step, kernel.Step, kernel.RepeatBoundary) kernel.Step
	}{
		{"outside_to_body", func(t *testing.T, b *kernel.Builder, entry, _ kernel.Step, boundary kernel.RepeatBoundary) kernel.Step {
			outside := addStep(t, b, noWork)
			depend(t, b, entry, outside)
			depend(t, b, boundary.Enter, outside)
			return outside
		}},
		{"body_to_outside", func(t *testing.T, b *kernel.Builder, _, exit kernel.Step, boundary kernel.RepeatBoundary) kernel.Step {
			outside := addStep(t, b, noWork)
			depend(t, b, outside, exit)
			return boundary.Enter
		}},
		{"enter_as_completion", func(t *testing.T, b *kernel.Builder, _, _ kernel.Step, boundary kernel.RepeatBoundary) kernel.Step {
			outside := addStep(t, b, noWork)
			depend(t, b, outside, boundary.Enter)
			return boundary.Enter
		}},
		{"outside_to_done", func(t *testing.T, b *kernel.Builder, _, _ kernel.Step, boundary kernel.RepeatBoundary) kernel.Step {
			outside := addStep(t, b, noWork)
			depend(t, b, boundary.Enter, outside)
			depend(t, b, boundary.Done, outside)
			return outside
		}},
		{"body_start_bypasses_enter", func(_ *testing.T, _ *kernel.Builder, entry, _ kernel.Step, _ kernel.RepeatBoundary) kernel.Step {
			return entry
		}},
		{"body_branch_cannot_reach_exit", func(t *testing.T, b *kernel.Builder, entry, _ kernel.Step, boundary kernel.RepeatBoundary) kernel.Step {
			side := addStep(t, b, noWork)
			depend(t, b, side, entry)
			return boundary.Enter
		}},
		{"overlapping_bodies", func(t *testing.T, b *kernel.Builder, entry, exit kernel.Step, boundary kernel.RepeatBoundary) kernel.Step {
			if _, err := b.Repeat(entry, exit, chooseBody, chooseDone); err != nil {
				t.Fatal(err)
			}
			return boundary.Enter
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var builder kernel.Builder
			entry := addStep(t, &builder, noWork)
			exit := addStep(t, &builder, noWork)
			depend(t, &builder, exit, entry)
			boundary := repeatSteps(t, &builder, entry, exit, chooseBody, chooseDone)
			start := test.change(t, &builder, entry, exit, boundary)
			if _, err := builder.Compile(start, 20); !errors.Is(err, kernel.ErrInvalidLayout) {
				t.Fatalf("unsealed repeat accepted: %v", err)
			}
		})
	}
}

func TestLayoutRejectsDisconnectedRepeatExit(t *testing.T) {
	var builder kernel.Builder
	entry := addStep(t, &builder, noWork)
	exit := addStep(t, &builder, noWork)
	boundary := repeatSteps(t, &builder, entry, exit, chooseBody, chooseDone)
	if _, err := builder.Compile(boundary.Enter, 20); !errors.Is(err, kernel.ErrInvalidLayout) {
		t.Fatalf("disconnected body exit accepted: %v", err)
	}
}

func TestLayoutRejectsOuterCyclesThroughRepeatBoundaries(t *testing.T) {
	var builder kernel.Builder
	start := addStep(t, &builder, noWork)
	first := addStep(t, &builder, noWork)
	second := addStep(t, &builder, noWork)
	firstBoundary := repeatSteps(t, &builder, first, first, chooseBody, chooseDone)
	secondBoundary := repeatSteps(t, &builder, second, second, chooseBody, chooseDone)
	depend(t, &builder, firstBoundary.Enter, start, secondBoundary.Done)
	depend(t, &builder, secondBoundary.Enter, firstBoundary.Done)
	if _, err := builder.Compile(start, 30); !errors.Is(err, kernel.ErrInvalidLayout) {
		t.Fatalf("outer dependency cycle through repeat boundaries accepted: %v", err)
	}
}

func noWork(context.Context) error { return nil }

func chooseBody(context.Context) (kernel.BoundaryRoute, error) { return kernel.RepeatBody, nil }

func chooseDone(context.Context) (kernel.BoundaryRoute, error) { return kernel.RepeatDone, nil }

func addStep(t *testing.T, builder *kernel.Builder, action kernel.Action) kernel.Step {
	t.Helper()
	step, err := builder.Add(action)
	if err != nil {
		t.Fatal(err)
	}
	return step
}

func depend(t *testing.T, builder *kernel.Builder, target kernel.Step, sources ...kernel.Step) {
	t.Helper()
	if err := builder.DependsOn(target, sources...); err != nil {
		t.Fatal(err)
	}
}

func repeatSteps(t *testing.T, builder *kernel.Builder, entry, exit kernel.Step,
	enter, advance kernel.BoundaryAction) kernel.RepeatBoundary {
	t.Helper()
	boundary, err := builder.Repeat(entry, exit, enter, advance)
	if err != nil {
		t.Fatal(err)
	}
	return boundary
}

func compileProgram(t *testing.T, builder *kernel.Builder, start kernel.Step, budget int) *kernel.Program {
	t.Helper()
	program, err := builder.Compile(start, budget)
	if err != nil {
		t.Fatal(err)
	}
	return program
}
