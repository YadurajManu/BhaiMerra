-- Services that exist only for other services.
--
-- A database has no business being published on the node's network interface,
-- but every service got a host port and a managed hostname whether or not
-- anything should be able to reach it from outside. `internal` is the opt out:
-- no published port, no hostname, no ingress route — reachable only by name
-- from other containers on the same node's fleet network.

ALTER TABLE "services" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;
