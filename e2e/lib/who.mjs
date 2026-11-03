// Sign-in now asks «من أنت؟» first (student / teacher / parent). Tests answer from the account they sign in with:
// a teacher or parent address, otherwise a student (phone numbers and wrong-account checks included).
// `who` overrides the guess. Works on a page or a locator (e.g. main#scr); if the form is already open for another
// choice, «… تغيير» is used first.
export async function pickWho(scope, ident, who) {
  const w = who ?? (/parent/i.test(ident) ? 'parent' : /teacher|qtest|^t\d*@/i.test(String(ident)) ? 'teacher' : 'student');
  const label = { student: 'أنا طالب', teacher: 'أنا معلم', parent: 'أنا ولي أمر' }[w];
  const title = { student: 'دخول الطالب', teacher: 'دخول المعلم', parent: 'دخول ولي الأمر' }[w];
  const question = scope.getByRole('group', { name: 'من أنت؟' });
  const form = scope.locator('#lg-email');
  await question.or(form).first().waitFor();
  if (await form.isVisible()) {
    if (await scope.getByRole('heading', { name: title }).count()) return;
    await scope.getByRole('button', { name: /؟ تغيير$/ }).click();
    await question.waitFor();
  }
  await question.getByRole('button', { name: new RegExp(`^${label}`) }).click();
  await form.waitFor();
}
