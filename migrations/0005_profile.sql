-- =============================================================================
-- 0005 - profile - collaborative roles with multi-parent inheritance
-- =============================================================================

insert into profile (name, description, inheritance) values
  ('CREATIVE', 'Creative collaboration profile - innovative, expressive, imaginative', array['COLLABORATION']),
  ('DEVELOPER', 'Software development collaboration profile - clean, systematic, maintainable', array['ENGINEER']),
  ('ENGINEER', 'Technical engineering collaboration profile - focused, competent, authentic', array['COLLABORATION']),
  ('HUMANIST', 'Liberal arts and humanistic collaboration profile - thoughtful, analytical, expressive', array['COLLABORATION']),
  ('RESEARCHER', 'Academic research collaboration profile - rigorous, methodical, evidence-based', array['COLLABORATION']),
  ('TRANSLATOR', 'Professional translation collaboration profile - precise, culturally aware, systematic', array['COLLABORATION']),
  ('COLLABORATION', 'Shared collaboration context and methodology', array['INFRASTRUCTURE', 'INITIALIZATION', 'MEMORY', 'MONITORING', 'TEMPORAL']),
  ('INFRASTRUCTURE', 'Shared infrastructure context and methodology', '{}'),
  ('INITIALIZATION', 'Framework initialization and operations context', '{}'),
  ('MEMORY', 'Shared memory context and cache operations', '{}'),
  ('MONITORING', 'Shared monitoring observations for behavioral diagnostics', '{}'),
  ('TEMPORAL', 'Temporal awareness context for framework operations', '{}');

insert into platform_migrations (version, name) values (5, 'profile');
