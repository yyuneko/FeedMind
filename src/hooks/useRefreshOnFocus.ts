import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

type RefreshTarget = { hasData: boolean; isFetching: boolean; refetch: () => unknown };

export function useRefreshOnFocus(targets: RefreshTarget[]) {
  const targetsRef = useRef(targets);
  useEffect(() => { targetsRef.current = targets; }, [targets]);
  useFocusEffect(useCallback(() => {
    for (const target of targetsRef.current) {
      if (target.hasData && !target.isFetching) void target.refetch();
    }
  }, []));
}
