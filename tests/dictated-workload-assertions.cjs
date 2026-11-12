const {initial} = require('./reasoning-conversation-assertions.cjs');

module.exports = function check(state, today, reply) {
  return initial(state, reply, today);
};
