# 1. Record architecture decisions

Date: 2026-09-17

## Status

Accepted

## Context

This service spans an Azure DevOps extension, a backing service, a cache, a
config store and a write path into a system we do not own. Several of its
design choices are consequences of Azure DevOps' object model rather than
free choices, and the reasoning behind them is not recoverable from the code.
A reviewer who does not know that every board object is scoped to exactly one
team will read the aggregation layer as accidental complexity.

ExpertGroup standards require an ADR for significant architectural decisions.

## Decision

We record architecture decisions in `docs/adr/`, in Nygard format, numbered
sequentially and never edited once accepted. A decision that is reversed gets
a new ADR that supersedes the old one; the old one stays, marked Superseded.

## Consequences

The reasoning behind constrained choices survives the people who made them.
The cost is a short document per decision, written when the decision is made
rather than reconstructed at review time.
