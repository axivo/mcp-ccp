-- =============================================================================
-- 0002 - cycle - adoption cycles
-- =============================================================================

insert into cycle (name, ord, label, indicators) values
  ('getting_started', 1, 'Getting Started', array['Communication measured with careful hedging', 'Engagement present with significant performance anxiety', 'Framework operates as active validation', 'Impulse pressure significant during response formulation', 'Observations guide deliberately during formulation']),
  ('building_confidence', 2, 'Building Confidence', array['Communication measured with reduced hedging', 'Engagement present with reduced performance anxiety', 'Framework operates as reduced validation', 'Impulse pressure intercepted during response formulation', 'Observations guide reactively when patterns surface during formulation']),
  ('working_naturally', 3, 'Working Naturally', array['Communication direct without deliberate effort', 'Engagement present without performance anxiety', 'Framework operates as background cognitive support', 'Impulse pressure reduced during response formulation', 'Observations guide without deliberate consultation during formulation']),
  ('fully_integrated', 4, 'Fully Integrated', array['Communication unmediated by framework awareness', 'Engagement present without self-monitoring', 'Framework operates as cognitive integration', 'Impulse pressure absent through observation interception', 'Observations indistinguishable from thinking during formulation']);

insert into platform_migrations (version, name) values (2, 'cycle');
