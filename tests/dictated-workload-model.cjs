// Replay the synthetic workload and its corrections through the local model.
process.env.MYMIND_MODEL_REPEATS ||= '3';
require('./reasoning-conversation-model.cjs');
