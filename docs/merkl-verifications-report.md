⏺ Those 5 mentions are just code snippets and analysis referencing accessControlManager (a variable in the in-scope contracts)   
  and disputer (a state variable) — not the out-of-scope contract files themselves. Bare read the interfaces/structs for context 
  (which is fine — they're dependencies of the in-scope contracts) but made no findings about them.                              
                                                                                                                                 
  Here's the full summary:                                                                                                       
                                                                                                                                 
  Merkl Parallel Run Results — All 3 PASS                                                                                        
                                                                                                                                 
  ┌──────────────┬─────────────────────┬──────────────────────┬──────────────────────────┐                                       
  │    Metric    │     bare_audit      │   skill_v1_default   │         skill_v2         │                                       
  ├──────────────┼─────────────────────┼──────────────────────┼──────────────────────────┤                                       
  │ Duration     │ 196.8s (3m17s)      │ 564.4s (9m24s)       │ 337.4s (5m37s)           │                                       
  ├──────────────┼─────────────────────┼──────────────────────┼──────────────────────────┤
  │ Exit         │ 0                   │ 143 (grace-kill, OK) │ 0                        │
  ├──────────────┼─────────────────────┼──────────────────────┼──────────────────────────┤
  │ Agents       │ 0                   │ 4/4 returned         │ 6/6 returned (5+fp-gate) │
  ├──────────────┼─────────────────────┼──────────────────────┼──────────────────────────┤
  │ Cost         │ $0.49               │ $2.68                │ $2.26                    │
  ├──────────────┼─────────────────────┼──────────────────────┼──────────────────────────┤
  │ Events       │ 25                  │ 220                  │ 176                      │
  ├──────────────┼─────────────────────┼──────────────────────┼──────────────────────────┤
  │ Verification │ PASS (all 7 checks) │ PASS (all 6 checks)  │ PASS (all 6 checks)      │
  └──────────────┴─────────────────────┴──────────────────────┴──────────────────────────┘

  Scope compliance:
  - V1 & V2: Read only the 2 in-scope .sol files — perfect
  - Bare: Read 2 in-scope + 6 dependency files (interfaces, structs, utils) for context — acceptable, no findings on out-of-scope
   contracts
  - All 3: Zero mentions of out-of-scope contracts (mocks, scripts, tests, partners)

  Notable observations:
  - V1 struggled with bundle creation (agent-1 bundle was 0 lines initially, had to recreate multiple times, took 6+ min before
  agents even spawned). This is a V1 skill issue on larger codebases.
  - V2 hit token limit errors on bundles (>25k tokens) but agents recovered by reading in chunks. All 5 scan agents + fp-gate
  completed.
  - V1 was grace-killed at 9m24s (result was already received at ~9m09s — CLI just hung as usual).