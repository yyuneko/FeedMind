import { TextInput, type TextInputProps } from 'react-native';
import { useThemeColors } from '@/utils/theme';

export function AutofillSafeTextInput(props: TextInputProps) {
  const colors = useThemeColors();
  const secure = Boolean(props.secureTextEntry);
  return (
    <TextInput
      autoComplete={secure ? 'new-password' : 'off'}
      textContentType={secure ? 'newPassword' : 'none'}
      importantForAutofill='no'
      {...props}
      placeholderTextColor={props.placeholderTextColor ?? colors.subtle}
    />
  );
}
