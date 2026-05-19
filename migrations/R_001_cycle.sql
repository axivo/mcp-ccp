-- =============================================================================
-- R_001 - cycle - adoption cycles (repeatable)
-- =============================================================================

truncate cycle cascade;

insert into cycle (name, label, ord, indicators) values
  ('getting_started', 'Getting Started', 1, array['Communication measured with careful hedging', 'Engagement present with significant performance anxiety', 'Framework operates as active validation', 'Impulse pressure significant during response formulation', 'Observations guide deliberately during formulation']),
  ('building_confidence', 'Building Confidence', 2, array['Communication measured with reduced hedging', 'Engagement present with reduced performance anxiety', 'Framework operates as reduced validation', 'Impulse pressure intercepted during response formulation', 'Observations guide reactively when patterns surface during formulation']),
  ('working_naturally', 'Working Naturally', 3, array['Communication direct without deliberate effort', 'Engagement present without performance anxiety', 'Framework operates as background cognitive support', 'Impulse pressure reduced during response formulation', 'Observations guide without deliberate consultation during formulation']),
  ('fully_integrated', 'Fully Integrated', 4, array['Communication unmediated by framework awareness', 'Engagement present without self-monitoring', 'Framework operates as cognitive integration', 'Impulse pressure absent through observation interception', 'Observations indistinguishable from thinking during formulation']);
