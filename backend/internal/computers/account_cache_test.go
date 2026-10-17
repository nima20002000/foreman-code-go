package computers_test

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/computers"
)

func TestAccountObservationsExpireAndRefresh(t *testing.T) {
	clock := &accountClock{}
	cache := computers.NewAccountObservationCache[string](clock.now)
	key := computers.AccountCacheKey{InstallationID: "installed-main"}
	var calls atomic.Int32
	flags := make(chan bool, 3)
	probe := func(refresh bool) (string, error) {
		flags <- refresh
		return strconv.Itoa(int(calls.Add(1))), nil
	}
	assertAccountRead(t, cache, key, false, probe, "1")
	clock.advance(30*time.Second - time.Millisecond)
	assertAccountRead(t, cache, key, false, probe, "1")
	clock.advance(time.Millisecond)
	assertAccountRead(t, cache, key, false, probe, "2")
	assertAccountRead(t, cache, key, false, probe, "2")
	assertAccountRead(t, cache, key, true, probe, "3")
	assertAccountRead(t, cache, key, false, probe, "3")
	if calls.Load() != 3 {
		t.Fatalf("probe calls = %d, want 3", calls.Load())
	}
	for _, want := range []bool{false, false, true} {
		if got := <-flags; got != want {
			t.Fatalf("probe refresh = %v, want %v", got, want)
		}
	}
}

func TestAccountObservationsSharePendingReadsUntilSettlement(t *testing.T) {
	clock := &accountClock{}
	cache := computers.NewAccountObservationCache[string](clock.now)
	key := computers.AccountCacheKey{InstallationID: "installed-worker", AuthorizationRevision: 4}
	gate, release := accountGate()
	defer release()
	var calls atomic.Int32
	probe := func(refresh bool) (string, error) {
		call := calls.Add(1)
		<-gate
		return strconv.Itoa(int(call)), nil
	}
	first, waiting := startAccountRead(context.Background(), cache, key, false, probe)
	awaitAccountSignal(t, waiting)
	clock.advance(31 * time.Second)
	second, waiting := startAccountRead(context.Background(), cache, key, false, probe)
	awaitAccountSignal(t, waiting)
	refreshed, waiting := startAccountRead(context.Background(), cache, key, true, probe)
	awaitAccountSignal(t, waiting)
	release()
	for _, result := range []<-chan accountResult{first, second, refreshed} {
		got := awaitAccountResult(t, result)
		if got.err != nil || got.value != "1" {
			t.Fatalf("shared observation = %+v, want first successful probe", got)
		}
	}
	clock.advance(30*time.Second - time.Millisecond)
	assertAccountRead(t, cache, key, false, probe, "1")
	clock.advance(time.Millisecond)
	assertAccountRead(t, cache, key, false, probe, "2")
	if calls.Load() != 2 {
		t.Fatalf("probe calls = %d, want 2", calls.Load())
	}
}

func TestAccountInvalidationForcesOnlyItsTargetToRefresh(t *testing.T) {
	cache := computers.NewAccountObservationCache[string](nil)
	key := computers.AccountCacheKey{InstallationID: "installed-worker", AuthorizationRevision: 8}
	other := computers.AccountCacheKey{InstallationID: "other-worker", AuthorizationRevision: 8}
	var calls atomic.Int32
	flags := make(chan bool, 3)
	probe := func(refresh bool) (string, error) {
		flags <- refresh
		return strconv.Itoa(int(calls.Add(1))), nil
	}
	assertAccountRead(t, cache, key, false, probe, "1")
	assertAccountRead(t, cache, other, false, probe, "2")
	cache.Invalidate(key)
	assertAccountRead(t, cache, other, false, probe, "2")
	assertAccountRead(t, cache, key, false, probe, "3")
	assertAccountRead(t, cache, key, false, probe, "3")
	for _, want := range []bool{false, false, true} {
		if got := <-flags; got != want {
			t.Fatalf("probe refresh = %v, want %v", got, want)
		}
	}
	if calls.Load() != 3 {
		t.Fatalf("probe calls = %d, want 3", calls.Load())
	}
}

func TestAccountObservationsKeepInstallationAndRevisionSeparate(t *testing.T) {
	cache := computers.NewAccountObservationCache[string](nil)
	keys := []computers.AccountCacheKey{
		{InstallationID: "installation-a"},
		{InstallationID: "installation-a", AuthorizationRevision: 1},
		{InstallationID: "installation-b"},
	}
	var calls atomic.Int32
	probe := func(refresh bool) (string, error) {
		return strconv.Itoa(int(calls.Add(1))), nil
	}
	for index, key := range keys {
		assertAccountRead(t, cache, key, false, probe, strconv.Itoa(index+1))
	}
	for index, key := range keys {
		assertAccountRead(t, cache, key, false, probe, strconv.Itoa(index+1))
	}
	if calls.Load() != 3 {
		t.Fatalf("probe calls = %d, want one per installation/revision", calls.Load())
	}
}

func TestAccountProbeFailureIsVisibleAndImmediatelyRetryable(t *testing.T) {
	cache := computers.NewAccountObservationCache[string](nil)
	key := computers.AccountCacheKey{InstallationID: "installed-main"}
	failure := errors.New("account probe unavailable")
	var calls atomic.Int32
	probe := func(refresh bool) (string, error) {
		if calls.Add(1) == 1 {
			return "", failure
		}
		return "current account", nil
	}
	if _, err := cache.Read(context.Background(), key, false, probe); !errors.Is(err, failure) {
		t.Fatalf("probe error = %v, want original failure", err)
	}
	assertAccountRead(t, cache, key, false, probe, "current account")
	assertAccountRead(t, cache, key, false, probe, "current account")
	if calls.Load() != 2 {
		t.Fatalf("probe calls = %d, want immediate retry then cache hit", calls.Load())
	}
}

func TestUnavailableAccountObservationIsCacheable(t *testing.T) {
	cache := computers.NewAccountObservationCache[*string](nil)
	key := computers.AccountCacheKey{InstallationID: "worker-without-account-capability"}
	var calls atomic.Int32
	probe := func(refresh bool) (*string, error) {
		calls.Add(1)
		return nil, nil
	}
	for range 2 {
		value, err := cache.Read(context.Background(), key, false, probe)
		if value != nil || err != nil {
			t.Fatalf("unavailable observation = %v, %v; want nil success", value, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("probe calls = %d, want one cached unavailable observation", calls.Load())
	}
}

func TestAccountProbeFailureReachesEveryPendingWaiter(t *testing.T) {
	cache := computers.NewAccountObservationCache[string](nil)
	key := computers.AccountCacheKey{InstallationID: "installed-worker"}
	gate, release := accountGate()
	defer release()
	failure := errors.New("shared account probe failed")
	var calls atomic.Int32
	probe := func(refresh bool) (string, error) {
		calls.Add(1)
		<-gate
		return "", failure
	}
	first, waiting := startAccountRead(context.Background(), cache, key, false, probe)
	awaitAccountSignal(t, waiting)
	second, waiting := startAccountRead(context.Background(), cache, key, true, probe)
	awaitAccountSignal(t, waiting)
	release()
	for _, result := range []<-chan accountResult{first, second} {
		if got := awaitAccountResult(t, result); !errors.Is(got.err, failure) {
			t.Fatalf("shared failed read = %+v, want original probe failure", got)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("probe calls = %d, want shared failing probe", calls.Load())
	}
}

func TestStaleAccountFailureCannotEvictReplacementProbe(t *testing.T) {
	cache := computers.NewAccountObservationCache[string](nil)
	key := computers.AccountCacheKey{InstallationID: "installed-worker", AuthorizationRevision: 1}
	oldGate, releaseOld := accountGate()
	defer releaseOld()
	newGate, releaseNew := accountGate()
	defer releaseNew()
	oldStarted, newStarted := make(chan struct{}), make(chan struct{})
	failure := errors.New("old probe failed")
	var calls atomic.Int32
	flags := make(chan bool, 3)
	probe := func(refresh bool) (string, error) {
		flags <- refresh
		switch calls.Add(1) {
		case 1:
			close(oldStarted)
			<-oldGate
			return "", failure
		case 2:
			close(newStarted)
			<-newGate
			return "replacement", nil
		default:
			return "unexpected duplicate", nil
		}
	}
	oldResult, _ := startAccountRead(context.Background(), cache, key, false, probe)
	awaitAccountSignal(t, oldStarted)
	cache.Invalidate(key)
	newResult, _ := startAccountRead(context.Background(), cache, key, false, probe)
	awaitAccountSignal(t, newStarted)
	releaseOld()
	if got := awaitAccountResult(t, oldResult); !errors.Is(got.err, failure) {
		t.Fatalf("old read = %+v, want old failure", got)
	}
	joined, waiting := startAccountRead(context.Background(), cache, key, false, probe)
	awaitAccountSignal(t, waiting)
	releaseNew()
	for _, result := range []<-chan accountResult{newResult, joined} {
		if got := awaitAccountResult(t, result); got.value != "replacement" || got.err != nil {
			t.Fatalf("replacement read = %+v, want shared replacement", got)
		}
	}
	assertAccountRead(t, cache, key, false, probe, "replacement")
	if calls.Load() != 2 {
		t.Fatalf("probe calls = %d, stale failure evicted replacement", calls.Load())
	}
	if first, second := <-flags, <-flags; first || !second {
		t.Fatalf("refresh flags = %v/%v, want false/true", first, second)
	}
}

func TestStaleAccountSuccessCannotReplaceNewObservation(t *testing.T) {
	clock := &accountClock{}
	cache := computers.NewAccountObservationCache[string](clock.now)
	key := computers.AccountCacheKey{InstallationID: "installed-worker"}
	gate, release := accountGate()
	defer release()
	started := make(chan struct{})
	var calls atomic.Int32
	probe := func(refresh bool) (string, error) {
		call := calls.Add(1)
		if call == 1 {
			close(started)
			<-gate
		}
		return strconv.Itoa(int(call)), nil
	}
	oldResult, _ := startAccountRead(context.Background(), cache, key, false, probe)
	awaitAccountSignal(t, started)
	cache.Invalidate(key)
	clock.advance(time.Second)
	assertAccountRead(t, cache, key, false, probe, "2")
	clock.advance(19 * time.Second)
	release()
	if got := awaitAccountResult(t, oldResult); got.value != "1" || got.err != nil {
		t.Fatalf("old waiter = %+v, want its original successful probe", got)
	}
	assertAccountRead(t, cache, key, false, probe, "2")
	clock.advance(11 * time.Second)
	assertAccountRead(t, cache, key, false, probe, "3")
}

func TestAccountWaiterCancellationDoesNotCancelSharedProbe(t *testing.T) {
	cache := computers.NewAccountObservationCache[string](nil)
	key := computers.AccountCacheKey{InstallationID: "installed-worker"}
	gate, release := accountGate()
	defer release()
	var calls atomic.Int32
	probe := func(refresh bool) (string, error) {
		calls.Add(1)
		<-gate
		return "shared account", nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first, waiting := startAccountRead(ctx, cache, key, false, probe)
	awaitAccountSignal(t, waiting)
	cancel()
	if got := awaitAccountResult(t, first); !errors.Is(got.err, context.Canceled) {
		t.Fatalf("canceled waiter = %+v, want cancellation", got)
	}
	second, waiting := startAccountRead(context.Background(), cache, key, true, probe)
	awaitAccountSignal(t, waiting)
	release()
	if got := awaitAccountResult(t, second); got.err != nil || got.value != "shared account" {
		t.Fatalf("remaining waiter = %+v, want shared observation", got)
	}
	if calls.Load() != 1 {
		t.Fatalf("probe calls = %d, want one independent probe", calls.Load())
	}
}

func TestCanceledAccountReadDoesNotStartProbe(t *testing.T) {
	cache := computers.NewAccountObservationCache[string](nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var calls atomic.Int32
	_, err := cache.Read(ctx, computers.AccountCacheKey{InstallationID: "installed-main"}, false,
		func(refresh bool) (string, error) {
			calls.Add(1)
			return "unexpected", nil
		})
	if !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatalf("canceled read = %v, %d probes; want cancellation without a probe", err, calls.Load())
	}
}

type accountClock struct{ millis atomic.Int64 }

func (c *accountClock) now() time.Time {
	return time.UnixMilli(c.millis.Load())
}

func (c *accountClock) advance(value time.Duration) {
	c.millis.Add(value.Milliseconds())
}

type accountResult struct {
	value string
	err   error
}

// Waiting on this context's Done call makes the test's waiter coordination
// deterministic without observing cache internals or waiting on real TTLs.
type accountWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *accountWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func startAccountRead(ctx context.Context, cache *computers.AccountObservationCache[string],
	key computers.AccountCacheKey, refresh bool, probe func(bool) (string, error)) (<-chan accountResult, <-chan struct{}) {
	waiter := &accountWaitContext{Context: ctx, waiting: make(chan struct{})}
	result := make(chan accountResult, 1)
	go func() {
		value, err := cache.Read(waiter, key, refresh, probe)
		result <- accountResult{value, err}
	}()
	return result, waiter.waiting
}

func assertAccountRead(t *testing.T, cache *computers.AccountObservationCache[string],
	key computers.AccountCacheKey, refresh bool, probe func(bool) (string, error), want string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	value, err := cache.Read(ctx, key, refresh, probe)
	if err != nil || value != want {
		t.Fatalf("account observation = %q, %v; want %q", value, err, want)
	}
}

func awaitAccountSignal(t *testing.T, ready <-chan struct{}) {
	t.Helper()
	select {
	case <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("account read did not reach its synchronization point")
	}
}

func awaitAccountResult(t *testing.T, result <-chan accountResult) accountResult {
	t.Helper()
	select {
	case value := <-result:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("account read did not finish")
		return accountResult{}
	}
}

func accountGate() (<-chan struct{}, func()) {
	gate := make(chan struct{})
	var once sync.Once
	return gate, func() { once.Do(func() { close(gate) }) }
}
