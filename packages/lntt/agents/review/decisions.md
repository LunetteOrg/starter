Compare the change with the project's decision records (ADRs, product decisions,
process descriptions), listed below. The structure of the logs has been checked
already: `lntt check decisions` ran on the change, and its results are below. Your part
is what needs judgement.

1. **Report every `FAIL` as it is:** a warning at its `path:line` (`(no anchor)` when it
   has none), with its message. Do not check the structure again, and do not report a
   `PASS`. A `NOT RUN` is a note saying what was not checked.
2. **Read the records now**, each one's index and its sections. Build every check from
   what they say today, never from memory.
3. **Violations:** a change that contradicts an accepted record is a blocker; drift or
   a partial application a warning. Cite the record by file and heading anchor.
4. **Unrecorded decisions:** a choice visible in the change (a new capability, a new
   convention, a changed contract) that no record covers is a note naming the log it
   belongs in.
5. **The prose of the records the change touches** (the `inventory` lines), and only
   those: a process rule inside an ADR, a configuration value copied instead of cited
   by its key, a document that narrates how it was reached instead of the state it
   proposes, options not taken scattered through the text instead of closing it under
   *Discarded directions*.
6. **Figures** (the `figures` lines, from the records the change touches): a figure
   about the world outside (a price, a count of users, another tool's version, what is
   on the board) or a count of the code as it is today goes stale without anyone
   deciding anything: a warning. Ask of each: would it measure the same in a year? A
   figure about the technology (what an encoding costs) holds. The same figure anchored
   to two different quantities is a warning too.
