# RepoBrain Agent Navigation

RepoBrain navigation turns user intent into a small set of canonical repository sources and live checks.

## Authority

Use this order when sources disagree:

1. explicit current user instruction;
2. repository policy and current executable contracts;
3. durable RepoBrain knowledge;
4. stable documentation;
5. last-observed or historical notes.

Dynamic repository facts such as SHA, PR state, CI, deployment state, or open branches must be reverified live.

## Bootstrap

For a task-aware agent:

1. identify the task;
2. select the closest route in `ROUTES.yaml`;
3. load only that route's sources;
4. perform its `live_checks`;
5. follow its `then` steps;
6. expand context only when evidence requires it.

Shell-capable agents should use `brain start` / `brain conversation-start` so RepoBrain can combine durable context, skill routing, and repository navigation.

Repository-reading agents that cannot access local `.brain/` state may use `.brain/shared/index.md` when it has been explicitly committed.

## Durable memory boundary

`.brain/` remains the only durable RepoBrain store. Do not create a second memory database or copy durable knowledge into navigation documents.

Local RepoBrain state is private/ignored by default. `brain share` explicitly selects active memories for portable Git sharing. Raw provenance evidence remains opt-in.

## Failure behavior

A selected route with malformed required safeguards or missing required sources is non-consumable. Surface the warning rather than silently continuing with an incomplete route.
