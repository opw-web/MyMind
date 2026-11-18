import React, {forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {EventItem, Snapshot, ActionPreviewTarget} from '../shared/model';
import {daysBetween, shiftDate, weekday} from '../shared/dates';
import {Icon} from './App';
import {PixelFlower} from './Pixel';
import {previewClass} from './BloomControls';

const HOUR_PX = 66;
const GUTTER = 68;
const HEADER_HEIGHT = 76;
const ALL_DAY_HEIGHT = 62;
const MINUTE_PX = HOUR_PX / 60;
const MIN_DAY_WIDTH = 148;
const EXTEND_DAYS = 60;
const HOURS = Array.from({length: 24}, (_, hour) => hour);

export interface CalendarHandle {
  goTo(date: string, smooth?: boolean, time?: string | null): void;
}
export interface BlockSlot {date: string; startTime?: string; endTime?: string; allDay?: boolean}
interface Props {
  snapshot: Snapshot;
  today: string;
  now: number;
  hiddenCategories: ReadonlySet<string>;
  target: ActionPreviewTarget | null;
  onOpen: (event: EventItem) => void;
  onNew: (slot: BlockSlot) => void;
  onLead: (date: string) => void;
}
interface Selection {date: string; origin: number; column: HTMLElement}
interface DragRange {date: string; first: number; last: number}
interface Segment {event: EventItem; start: number; end: number; lane: number; lanes: number}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clock = (at: number) => `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
const hourLabel = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
function timeLabel(time: string) {
  const [hour, minute] = time.split(':');
  return `${Number(hour) % 12 || 12}:${minute} ${Number(hour) < 12 ? 'AM' : 'PM'}`;
}

function getSlot(y: number, column: HTMLElement) {
  return Math.min(1410, Math.floor(Math.max(0, y - column.getBoundingClientRect().top) / (MINUTE_PX * 30)) * 30);
}

function layoutBlocks(events: EventItem[], date: string) {
  const segments = events.flatMap(event => {
    if (!event.startTime) return [];
    const start = event.startDate === date ? minutes(event.startTime) : 0;
    const end = event.endDate === date ? event.endTime ? minutes(event.endTime) : Math.min(1440, start + 60) : 1440;
    return [{event, start, end: Math.max(start + 19 / MINUTE_PX, end), lane: 0, lanes: 1}];
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  let group: Segment[] = [];
  let groupEnd = 0;
  const finish = () => {
    const lanes = Math.max(1, ...group.map(segment => segment.lane + 1));
    for (const segment of group) segment.lanes = lanes;
    group = [];
    groupEnd = 0;
  };
  for (const segment of segments) {
    if (segment.start >= groupEnd) finish();
    const occupied = new Set(group.filter(other => other.end > segment.start).map(other => other.lane));
    while (occupied.has(segment.lane)) segment.lane++;
    group.push(segment);
    groupEnd = Math.max(groupEnd, segment.end);
  }
  finish();
  return segments;
}

const BloomCalendar = forwardRef<CalendarHandle, Props>(function BloomCalendar(
  {snapshot, today, now, hiddenCategories, target, onOpen, onNew, onLead}, ref,
) {
  const [anchor] = useState(today);
  const [range, setRange] = useState({start: -90, end: 121});
  const [dayWidth, setDayWidth] = useState(MIN_DAY_WIDTH);
  const [layout, setLayout] = useState(0);
  const [drag, setDrag] = useState<DragRange | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const lead = useRef(today);
  const pending = useRef<{date: string; top?: number; smooth?: boolean} | null>(null);
  const shift = useRef(0);
  const previousWidth = useRef(dayWidth);
  const measured = useRef(0);
  const selection = useRef<Selection | null>(null);

  const days = useMemo(() => Array.from({length: range.end - range.start}, (_, index) => shiftDate(anchor, range.start + index)), [anchor, range]);
  const taskTitles = useMemo(() => new Map(snapshot.tasks.map(task => [task.id, task.title])), [snapshot.tasks]);
  const categoryColors = useMemo(() => new Map(snapshot.categories.map(category => [category.id, category.color])), [snapshot.categories]);
  const eventsByDay = useMemo(() => {
    const map = new Map<string, EventItem[]>();
    const events = target?.entity === 'event' && target.before && !snapshot.events.some(event => event.id === target.id)
      ? [...snapshot.events, {...target.before, id: target.id} as unknown as EventItem]
      : snapshot.events;
    for (const event of events) {
      if (event.categoryId && hiddenCategories.has(event.categoryId) && !(target?.entity === 'event' && target.id === event.id)) continue;
      const first = Math.max(0, daysBetween(days[0], event.startDate));
      const last = Math.min(days.length - 1, daysBetween(days[0], event.endDate));
      for (let index = first; index <= last; index++) {
        const date = days[index];
        if (event.startTime && event.startDate !== date && event.endDate === date && event.endTime === '00:00') continue;
        const list = map.get(date) ?? [];
        list.push(event);
        map.set(date, list);
      }
    }
    return map;
  }, [snapshot.events, days, hiddenCategories, target]);

  function request(next: NonNullable<typeof pending.current>) {
    const offset = daysBetween(anchor, next.date);
    pending.current = next;
    if (offset < range.start || offset + 8 >= range.end) {
      setRange(current => Math.abs(offset - current.start) > 720
        ? {start: offset - 90, end: offset + 121}
        : {start: Math.min(current.start, offset - 60), end: Math.max(current.end, offset + 60)});
    }
    setLayout(value => value + 1);
  }

  useImperativeHandle(ref, () => ({
    goTo: (date, smooth, time) => request({date, smooth, top: time ? Math.max(0, minutes(time) * MINUTE_PX - 25) : undefined}),
  }));

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      if (!element.clientWidth) return;
      measured.current = Math.max(MIN_DAY_WIDTH, Math.floor((element.clientWidth - GUTTER - 1) / 7));
      setDayWidth(measured.current);
      setLayout(value => value + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  function publishPosition(element: HTMLDivElement) {
    const column = element.scrollLeft / dayWidth;
    const index = Math.max(0, Math.min(days.length - 1, Math.floor(column + 0.01)));
    const date = days[index];
    if (date !== lead.current) {
      lead.current = date;
      onLead(date);
    }
  }

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element?.clientWidth || measured.current !== dayWidth) return;
    const move = pending.current ?? (!started.current ? {date: today, top: 7 * HOUR_PX} : undefined);
    if (move) {
      const offset = daysBetween(days[0], move.date);
      if (offset >= 0 && offset < days.length) {
        element.scrollTo({
          left: offset * dayWidth,
          top: move.top ?? element.scrollTop,
          behavior: 'smooth' in move && move.smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant',
        });
        pending.current = null;
        shift.current = 0;
        started.current = true;
      }
    } else if (shift.current || previousWidth.current !== dayWidth) {
      element.scrollLeft = element.scrollLeft * dayWidth / previousWidth.current + shift.current * dayWidth;
      shift.current = 0;
    }
    previousWidth.current = dayWidth;
    if (started.current) publishPosition(element);
  }, [days, dayWidth, layout]);

  function onScroll() {
    const element = scroller.current;
    if (!element?.clientWidth || !started.current) return;
    publishPosition(element);
    if (pending.current || shift.current) return;
    if (element.scrollLeft < dayWidth * 8) {
      shift.current = EXTEND_DAYS;
      setRange(current => ({...current, start: current.start - EXTEND_DAYS}));
    } else if (element.scrollWidth - element.scrollLeft - element.clientWidth < dayWidth * 8) {
      setRange(current => ({...current, end: current.end + EXTEND_DAYS}));
    }
  }

  useEffect(() => {
    function move(event: PointerEvent) {
      const active = selection.current;
      if (active) setDrag({date: active.date, first: active.origin, last: getSlot(event.clientY, active.column)});
    }
    function cancel() {
      selection.current = null;
      setDrag(null);
    }
    function finish(event: PointerEvent) {
      const active = selection.current;
      if (!active) return;
      cancel();
      const at = getSlot(event.clientY, active.column);
      const first = Math.min(active.origin, at);
      const last = Math.max(active.origin, at);
      const end = Math.min(1439, last + (first === last ? 60 : 30));
      onNew({date: active.date, startTime: clock(first), endTime: clock(end)});
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [onNew]);

  function renderBlock(event: EventItem, date: string, segment?: Segment) {
    const title = (event.linkedTaskId && taskTitles.get(event.linkedTaskId)) || event.title;
    const color = (event.categoryId && categoryColors.get(event.categoryId)) || event.color;
    const css = ` color-${color}${previewClass(target, 'event', date === event.startDate ? event.id : '')}`;
    const deleted = target?.entity === 'event' && target.id === event.id && !!target.before;
    const data = {'data-event-id': event.id, 'data-entry-type': 'session', 'data-start-date': event.startDate, 'data-end-date': event.endDate,
      'data-linked-task': event.linkedTaskId ?? undefined};
    if (!segment || !event.startTime) return <button type="button" key={event.id} {...data} className={'all-day-chip' + css}
      disabled={deleted} title={title} onClick={click => {click.stopPropagation(); onOpen(event);}}>{title}</button>;
    const {start, end, lane, lanes} = segment;
    const height = (end - start) * MINUTE_PX;
    const timing = `${timeLabel(event.startTime)}${event.endTime ? ' – ' + timeLabel(event.endTime) : ''}`;
    return <button type="button" key={event.id} {...data} className={`event-block${height < 47 ? ' event-compact' : ''}${css}`}
      style={{top: start * MINUTE_PX, height, left: `calc(${lane / lanes * 100}% + 5px)`, width: `calc(${100 / lanes}% - 11px)`}}
      title={`${title} · ${timing}`} disabled={deleted} onClick={() => onOpen(event)}>
      <span className="event-title">{title}</span><span className="event-time">{timing}</span>
      {event.linkedTaskId && <span className="event-link"><Icon name="link" size={11}/></span>}
    </button>;
  }

  const localTime = new Intl.DateTimeFormat('en-GB', {timeZone: snapshot.preferences.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(now));
  const column = {width: dayWidth, minWidth: dayWidth};
  const gutter = {width: GUTTER, minWidth: GUTTER};
  return <div className="calendar-panel" ref={scroller} data-testid="calendar-scroller" onScroll={onScroll}>
    <div className="calendar-sheet" style={{width: GUTTER + days.length * dayWidth}}>
      <div className="day-headers" style={{height: HEADER_HEIGHT}}>
        <div className="corner-label" style={gutter}>TIME <PixelFlower size={14}/></div>
        {days.map(date => <div key={date} className={`day-header ${date === today ? 'is-today' : ''}`} style={column} data-date={date}>
          <span className="weekday">{weekday(date)}</span><span className="day-number">{Number(date.slice(8))}</span>
          {date === today && <span className="today-dot"/>}
        </div>)}
      </div>
      <div className="allday-row" style={{height: ALL_DAY_HEIGHT}}>
        <div className="all-day-gutter" style={gutter}><span>all-day</span></div>
        {days.map(date => <div key={date} className="all-day-cell" style={column} data-date={date} onClick={() => onNew({date, allDay: true})}>
          {eventsByDay.get(date)?.filter(event => !event.startTime).map(event => renderBlock(event, date))}
        </div>)}
      </div>
      <div className="hour-area" style={{height: 24 * HOUR_PX}}>
        <div className="hour-gutter" style={gutter}>{HOURS.map(hour => <div key={hour} className="hour-mark" style={{top: hour * HOUR_PX}}>{hourLabel(hour)}</div>)}</div>
        {days.map(date => <div key={date} className={`time-column ${date === today ? 'time-today' : ''}`}
          style={column} data-date={date} onPointerDown={event => {
            if (event.button !== 0 || event.target !== event.currentTarget) return;
            const origin = getSlot(event.clientY, event.currentTarget);
            selection.current = {date, origin, column: event.currentTarget};
            setDrag({date, first: origin, last: origin});
          }}>
          {drag?.date === date && <div className="drag-ghost" style={{top: Math.min(drag.first, drag.last) * MINUTE_PX, height: (Math.abs(drag.first - drag.last) + 30) * MINUTE_PX}}/>}
          {layoutBlocks(eventsByDay.get(date) ?? [], date).map(segment => renderBlock(segment.event, date, segment))}
          {date === today && <div className="now-line" style={{top: minutes(localTime) * MINUTE_PX}}><span className="now-bubble"/></div>}
        </div>)}
      </div>
    </div>
  </div>;
});

export default BloomCalendar;
