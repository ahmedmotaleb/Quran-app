// Sign-in has a «طالب / معلم / ولي أمر» choice at the top (default طالب); for طالب and معلم the server refuses an
// account of another role. Tests pick the choice that matches the account they sign in with (a teacher or parent
// address, otherwise a student; `who` overrides the guess). Works on a page or a locator (e.g. main#scr).
export async function pickWho(scope, ident, who) {
  const w = who ?? (/parent/i.test(ident) ? 'parent' : /teacher|khalid|qtest|^t\d*@/i.test(String(ident)) ? 'teacher' : 'student');
  const label = { student: 'طالب', teacher: 'معلم', parent: 'ولي أمر' }[w];
  const radio = scope.getByRole('radiogroup', { name: 'نوع الحساب' }).getByRole('radio', { name: label, exact: true });
  await radio.waitFor();
  if ((await radio.getAttribute('aria-checked')) !== 'true') await radio.click();
}
