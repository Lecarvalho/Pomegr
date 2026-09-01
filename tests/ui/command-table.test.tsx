import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CommandTable, type CommandTableColumn } from "../../app/components/command-center/CommandTable";

type Row = { id: string; name: string; score: number | null };
const rows: Row[] = [
  { id: "a", name: "Item 10", score: 10 },
  { id: "b", name: "Item 2", score: 2 },
  { id: "c", name: "Item 1", score: null },
  { id: "d", name: "Item 3", score: 0 },
];
const columns: CommandTableColumn<Row>[] = [
  { id: "name", label: "Name", renderCell: (row) => row.name, sortValue: (row) => row.name },
  { id: "score", label: "Score", renderCell: (row) => row.score ?? "—", sortValue: (row) => row.score },
  { id: "action", label: "Open item", hideLabel: true, renderCell: (row) => <a href={"/items/" + row.id}>Open {row.name}</a> },
];
const getRowKey = (row: Row) => row.id;
function names(caption = "Items") {
  return within(screen.getByRole("table", { name: caption })).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);
}

describe("CommandTable", () => {
  it("renders arbitrary columns and keeps sorting opt-in", async () => {
    const user = userEvent.setup();
    render(<CommandTable caption="Items" rows={rows} columns={columns.map((column) => ({ ...column, sortValue: undefined }))} getRowKey={getRowKey} />);
    expect(names()).toEqual(["Item 10", "Item 2", "Item 1", "Item 3"]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getByRole("columnheader", { name: "Open item" })).toBeInTheDocument();
    await user.click(screen.getByRole("columnheader", { name: "Name" }));
    expect(names()).toEqual(["Item 10", "Item 2", "Item 1", "Item 3"]);
    expect(screen.getByRole("link", { name: "Open Item 2" })).toHaveAttribute("href", "/items/b");
  });

  it("sorts strings naturally, retains stable ties, and never mutates caller rows", async () => {
    const user = userEvent.setup();
    const tiedRows = [...rows, { id: "e", name: "Item 2", score: 2 }];
    const before = structuredClone(tiedRows);
    render(<CommandTable caption="Items" rows={tiedRows} columns={columns} getRowKey={getRowKey} />);
    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["Item 10", "Item 3", "Item 2", "Item 2", "Item 1"]);
    await user.keyboard("{Enter}");
    expect(names()).toEqual(["Item 1", "Item 2", "Item 2", "Item 3", "Item 10"]);
    expect(screen.getAllByRole("link", { name: "Open Item 2" }).map((link) => link.getAttribute("href"))).toEqual(["/items/b", "/items/e"]);
    expect(tiedRows).toEqual(before);
  });

  it("sorts numbers before pagination and retains the choice through empty and updated rows", async () => {
    const user = userEvent.setup();
    function PagedTable({ data }: { data: Row[] }) {
      const [page, setPage] = useState(1);
      return <CommandTable caption="Items" rows={data} columns={columns} getRowKey={getRowKey} pagination={{ page, pageSize: 2, onPageChange: setPage }} emptyState={<p>No matching items</p>} />;
    }
    const view = render(<PagedTable data={rows} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(names()).toEqual(["Item 1", "Item 3"]);
    await user.click(screen.getByRole("button", { name: "Score" }));
    expect(names()).toEqual(["Item 10", "Item 2"]);
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Score" }));
    expect(names()).toEqual(["Item 3", "Item 2"]);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(names()).toEqual(["Item 10", "Item 1"]);
    view.rerender(<PagedTable data={[]} />);
    expect(screen.getByText("No matching items")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    view.rerender(<PagedTable data={[{ ...rows[0], score: 1 }, rows[1]]} />);
    expect(names()).toEqual(["Item 10", "Item 2"]);
    expect(screen.getByRole("columnheader", { name: "Score" })).toHaveAttribute("aria-sort", "ascending");
  });

  it("ignores a selected sort when that column becomes unsortable", async () => {
    const user = userEvent.setup();
    const view = render(<CommandTable caption="Items" rows={rows} columns={columns} getRowKey={getRowKey} />);
    await user.click(screen.getByRole("button", { name: "Name" }));
    view.rerender(<CommandTable caption="Items" rows={rows} columns={columns.map((column) => ({ ...column, sortValue: undefined }))} getRowKey={getRowKey} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Name" })).not.toHaveAttribute("aria-sort");
    expect(names()).toEqual(["Item 10", "Item 2", "Item 1", "Item 3"]);
  });
});
