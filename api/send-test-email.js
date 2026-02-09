import { Resend } from 'resend';

const resend = new Resend('re_Lx4fjccu_34nkrXLVFtjzaEYqjFszveRZ');

resend.emails.send({
  from: 'onboarding@resend.dev',
  to: 'moonautodetailing@gmail.com',
  subject: 'Hello World',
  html: '<p>Congrats on sending your <strong>first email</strong>!</p>'
});
