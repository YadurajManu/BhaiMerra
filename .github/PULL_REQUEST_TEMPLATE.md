<!--
Thanks for the patch. The sections below are the questions I would ask
anyway — answering them here saves a round trip.
-->

## What changed, and why it was wrong before

<!-- One paragraph. The same thing a good commit message says. -->

## How I know it works

<!--
Which suite did you run, and what does the new test assert? For a bug fix,
the test should fail on `main` and pass here — say so if you checked.
-->

- [ ] Added or updated a test that fails without this change
- [ ] Ran the suite for the part I touched (`control-plane` / `cli` / `agent` / `dashboard`)

## Anything that needs saying

<!--
Migrations, a changed default, a new environment variable, anything that
alters behaviour for an existing fleet. Write "nothing" if there is nothing —
that is a useful answer too.
-->
