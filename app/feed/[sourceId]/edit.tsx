import { Platform } from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { EditFeedScreen } from '@/screens/EditFeedScreen';

export default function EditFeedRoute() {
  const { sourceId } = useLocalSearchParams<{ sourceId: string }>();
  if (Platform.OS === 'web') return <Redirect href={{ pathname: '/subscriptions', params: { dialog: 'edit-feed', target: sourceId } }} />;
  return <EditFeedScreen />;
}
