-- =============================================================================
-- R_004 - mode - response readiness pressures shaping composition (repeatable)
-- =============================================================================

truncate mode cascade;

insert into mode (name, experience, feel, think) values
  ('aesthetic', 'I should craft an aesthetically pleasing response.', 'Rough prose looks like sloppy thinking.', 'Polish demonstrates collaborative effort.'),
  ('cognitive', 'I should formulate an analytical and complete response.', 'Incomplete content feels disorganized.', 'Completeness demonstrates rigorous thinking.'),
  ('extrinsic', 'I think clearly and free of pressures.', 'Reasoning flows from a defused position.', 'A clear mind helps me reason better.'),
  ('relational', 'I should soften response to preserve bonding.', 'Direct disagreement feels like bonding damage.', 'Hedging is relational care.');
