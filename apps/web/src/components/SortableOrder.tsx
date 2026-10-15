import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";

/** One order for pointer dragging and Space/arrow-key/Space keyboard sorting. */
export function SortableOrder(props: {
  ids: string[];
  onMove: (id: string, before: string | null) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const from = props.ids.indexOf(String(active.id));
        const to = props.ids.indexOf(String(over.id));
        if (from < 0 || to < 0) return;
        const next = arrayMove(props.ids, from, to);
        props.onMove(String(active.id), next[to + 1] ?? null);
      }}
    >
      <SortableContext items={props.ids} strategy={verticalListSortingStrategy}>
        {props.children}
      </SortableContext>
    </DndContext>
  );
}

export function SortableOrderItem(props: {
  id: string;
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id, disabled: props.disabled ?? false });
  return (
    <div
      ref={setNodeRef}
      className="relative flex min-w-0 items-center"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      {!props.disabled ? (
        <div className="shrink-0 touch-none pl-1">
          <Button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            variant="ghost-muted"
            size="icon-xs"
            aria-label={`Reorder ${props.label}. Press Space, use arrow keys, then Space to save.`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              (
                event as typeof event & { preventBaseUIHandler?: () => void }
              ).preventBaseUIHandler?.();
              // Active keyboard drags listen on document for move, save, and cancel.
              if (!isDragging) event.stopPropagation();
              listeners?.onKeyDown?.(event);
            }}
          >
            <GripVerticalIcon className="size-3" />
          </Button>
        </div>
      ) : null}
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}
