-- What the node found when it asked a service which paths it answers.
--
-- `fleet init` writes "Add one once you know a path that returns 2xx" into
-- every manifest it generates: the generator admitting it cannot know, and
-- handing a research task to the reader. Nothing in a repository answers it --
-- which path returns 2xx is a property of the running program. So the agent,
-- which is on the node and already speaks HTTP, asks the container, and the
-- answer is kept here.
--
-- Nullable on purpose, and an empty array is not the same as null: null means
-- nobody has looked, and [] means every candidate was tried and none answered.
-- The second is true of a backend serving under a route prefix, and is exactly
-- what a manifest should record instead of guessing at "/".
ALTER TABLE services ADD COLUMN IF NOT EXISTS discovered_health jsonb;
ALTER TABLE services ADD COLUMN IF NOT EXISTS discovered_health_at timestamp with time zone;
