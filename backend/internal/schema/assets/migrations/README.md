# Later schema changes

Add a focused SQL migration as `<positive-number>_<domain_name>.sql`, such as
`0001_example.sql`. Version zero is not a numbered migration. Versions must be
unique; existing migration files are immutable once applied. Add later changes
in increasing numeric order.

The shared transaction helper owns transaction commands. These SQL files must
not issue `BEGIN`, `COMMIT`, or `ROLLBACK`. Startup validates every applied Go
migration against its name and checksum, rejects unknown or changed history,
and applies only the remaining suffix of the embedded migration sequence.

There are no later Go SQL migrations in this initial slice.
