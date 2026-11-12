const repairCorrection = 'What deadline should I use for the appliance repair? Update the appliance repair task: I meant a dishwasher repair at Maple Appliance Repair. Set the deadline to the end of this week. What did you mean by “mosaic profile”? I meant the portfolio update already listed.';

module.exports = {
  prompt: require('./dictated-workload-fixture.cjs'),
  repairCorrection,
  correction: repairCorrection + ' Rename that portfolio task to "Update workshop portfolio".',
  clarification: 'Actually, the dishwasher repair at Maple Appliance Repair can stay as written.'
};
