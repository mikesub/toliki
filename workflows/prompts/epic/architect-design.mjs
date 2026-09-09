// epic-run's architect prompt for a fresh design. The requirement below is the
// only spec context the step gets, and the design it returns fixes the shape of
// everything downstream, so this is the most expensive call to get wrong.

export const architectDesignPrompt = (requirement) =>
`Design the implementation approach for the requirement below. It goes straight to implementation.

The requirement — the orchestrator captured it from the issue, and it is the only spec context you get:
"""
${requirement}
"""

Introduce a new abstraction only when this requirement makes its longevity worth the cost, and say so in the rationale when you do. Return the schema-enforced JSON design, populating every field as its own description asks rather than crowding one of them.`
