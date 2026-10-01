// ECharts: подключаем только нужные модули, чтобы бандл оставался лёгким.
import { useEffect, useRef } from "react";
import { CustomChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  CustomChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
]);

export { echarts };
export type EChart = echarts.ECharts;

/** Экземпляр графика на элементе: создаётся один раз, следит за размером контейнера. */
export function useEChart(onInit?: (c: EChart) => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chart = useRef<EChart | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chart.current = c;
    onInit?.(c);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { ref, chart };
}
