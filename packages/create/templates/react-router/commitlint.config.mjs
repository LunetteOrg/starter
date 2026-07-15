export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        // An em/en dash in the subject reads as a silent rejection with the default
        // config and is easy to paste by accident. Fail it with a readable message.
        'subject-no-em-dash': ({ subject }) => [
          !subject || !/[—–]/.test(subject),
          "subject must not contain an em/en dash (— or –) — use a plain hyphen '-' or rephrase",
        ],
      },
    },
  ],
  rules: {
    'subject-no-em-dash': [2, 'always'],
  },
}
