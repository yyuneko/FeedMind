import { TextInput, type TextInputProps } from 'react-native';

export function AutofillSafeTextInput(props: TextInputProps) {
  const secure = Boolean(props.secureTextEntry);
  return (
    <TextInput
      autoComplete={secure ? 'new-password' : 'off'}
      textContentType={secure ? 'newPassword' : 'none'}
      importantForAutofill='no'
      {...props}
    />
  );
}
