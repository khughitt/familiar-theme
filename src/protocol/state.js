export const STATES = ['idle', 'working', 'needs-input', 'needs-approval', 'error', 'done'];

export function assertState(state) {
  if (!STATES.includes(state)) throw new Error(`unknown state: ${state}`);
  return state;
}
