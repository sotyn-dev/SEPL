// Previous pending is the opening workload, not just what remains after
// this week's completions. Both figures must describe the same cohort.
function previousBacklog(remaining, completed) {
  const open = Math.max(0, Number(remaining) || 0);
  const done = Math.max(0, Number(completed) || 0);
  return { pending: open + done, done };
}
module.exports = { previousBacklog };
