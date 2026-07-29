'use strict';

/** Wraps an async route handler so thrown errors reach the error middleware. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Resolve the caller's `doctors` row id from their profile, or null. */
async function resolveDoctorId(supabase, userId) {
  const { data } = await supabase
    .from('doctors')
    .select('id')
    .eq('profile_id', userId)
    .maybeSingle();
  return data ? data.id : null;
}

module.exports = { asyncHandler, resolveDoctorId };
