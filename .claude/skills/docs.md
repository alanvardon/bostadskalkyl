---
name: docs
description: Generate or update documentation. Use when user mentions 
  "docs", "documentation", "README", "JSDoc", or "comments".
allowed-tools: Read, Write, Edit, Glob
---

Determine what needs documenting:

**If README**: Generate project overview, setup, usage, and API reference
**If JSDoc/docstrings**: Add to all exported functions and classes
**If inline comments**: Add to complex logic only (not obvious code)

For each documented item include:
- Description of what it does (one sentence)
- Parameters with types and descriptions
- Return value with type
- Example usage (if non-obvious)
- Throws/errors (if applicable)

Style rules:
- Match existing documentation style in the project
- Be concise, not verbose
- Document WHY, not WHAT (the code shows what)