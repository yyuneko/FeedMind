import { Alert, Platform } from 'react-native';

type ConfirmActionOptions = {
  title: string;
  message: string;
  cancelText: string;
  confirmText: string;
  onConfirm: () => void;
};

export const confirmDestructiveAction = ({ title, message, cancelText, confirmText, onConfirm }: ConfirmActionOptions) => {
  if (Platform.OS === 'web') {
    if (globalThis.confirm(title + '\n\n' + message)) onConfirm();
    return;
  }

  Alert.alert(title, message, [
    { text: cancelText, style: 'cancel' },
    { text: confirmText, style: 'destructive', onPress: onConfirm },
  ]);
};
