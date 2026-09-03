import { StyleSheet, View } from 'react-native';
import { LoadingIndicator } from '@/components/LoadingIndicator';
import { spacing } from '@/utils/theme';

type Props = {
  label: string;
  pagination?: boolean;
  footer?: boolean;
};

export const ListLoadingIndicator = ({ label, pagination = false, footer = false }: Props) => {
  return (
    <View
      style={[styles.row, (pagination || footer) && styles.pagination]}
    >
      <LoadingIndicator compact label={label} />
    </View>
  );
};

const styles = StyleSheet.create({
  row: { minHeight: 32, paddingHorizontal: spacing.xl },
  pagination: { minHeight: 52, paddingVertical: spacing.md },
});
