import { useLocalSearchParams } from 'expo-router';
import { CollectionScreen } from '@/screens/CollectionScreen';
export default function FeedRoute() { const { sourceId } = useLocalSearchParams<{ sourceId: string }>(); return <CollectionScreen collection={{ kind: 'feed', sourceId }} />; }
