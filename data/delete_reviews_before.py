#!/usr/bin/env python3
"""删除指定时间以前的课程评论，并同步所有派生统计数据。

默认仅预览；传入 --apply 后才会写入文件。写入前会自动备份所有将被
修改的文件，任一写入失败时会尝试从备份恢复。
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DATA_DIR = Path(__file__).resolve().parent
COURSES_DIR = DATA_DIR / "courses"
TEACHERS_DIR = DATA_DIR / "teachers"
WITH_COMMENT_PATH = DATA_DIR / "with_comment_index.json"
FULL_INDEX_PATH = DATA_DIR / "full_index.json"
MANIFEST_PATH = DATA_DIR / "manifest.json"

TIME_FORMATS = (
    "%Y-%m-%d",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%Y/%m/%d",
    "%Y/%m/%d %H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%dT%H:%M:%S",
)


class DataError(RuntimeError):
    """输入数据不完整或格式不正确。"""


@dataclass(frozen=True)
class CourseStats:
    count: int
    avg: int | float


@dataclass
class PendingWrite:
    data: Any
    indent: int


def parse_datetime(value: str, *, label: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise DataError(f"{label} 缺失或不是字符串")

    value = value.strip()
    for fmt in TIME_FORMATS:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass

    supported = "、".join(
        ("YYYY-MM-DD", "YYYY-MM-DD HH:MM[:SS]", "YYYY/MM/DD HH:MM[:SS]")
    )
    raise DataError(f"{label} 的时间格式无效: {value!r}；支持 {supported}")


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError as exc:
        raise DataError(f"缺少文件: {path}") from exc
    except json.JSONDecodeError as exc:
        raise DataError(
            f"JSON 格式错误: {path}（第 {exc.lineno} 行，第 {exc.colno} 列）"
        ) from exc


def normalize_id(value: Any, *, label: str) -> int:
    if isinstance(value, bool):
        raise DataError(f"{label} 不是有效的整数 ID: {value!r}")
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise DataError(f"{label} 不是有效的整数 ID: {value!r}") from exc
    if str(normalized) != str(value).strip():
        raise DataError(f"{label} 不是规范的整数 ID: {value!r}")
    return normalized


def calculate_stats(results: list[dict[str, Any]], *, source: Path) -> CourseStats:
    ratings: list[float] = []
    for index, review in enumerate(results):
        rating = review.get("rating")
        if isinstance(rating, bool) or not isinstance(rating, (int, float)):
            raise DataError(f"{source}: results[{index}].rating 不是数字")
        if not math.isfinite(rating):
            raise DataError(f"{source}: results[{index}].rating 不是有限数值")
        ratings.append(rating)

    if not ratings:
        return CourseStats(count=0, avg=0.0)

    average = sum(ratings) / len(ratings)
    # 与现有 JSON 风格保持一致：整均分写成整数，非整均分保留精确算术平均。
    normalized_average: int | float = (
        int(average) if average.is_integer() else average
    )
    return CourseStats(count=len(results), avg=normalized_average)


def course_id_from_path(path: Path) -> int:
    if not path.stem.isdigit():
        raise DataError(f"课程文件名必须是数字 sqid: {path.name}")
    return int(path.stem)


def add_write_if_changed(
    writes: dict[Path, PendingWrite],
    path: Path,
    original: Any,
    updated: Any,
    *,
    indent: int,
) -> None:
    if original != updated:
        writes[path] = PendingWrite(data=updated, indent=indent)


def json_bytes(data: Any, *, indent: int) -> bytes:
    text = json.dumps(data, ensure_ascii=False, indent=indent, allow_nan=False)
    return (text + "\n").encode("utf-8")


def atomic_write_json(path: Path, pending: PendingWrite) -> None:
    content = json_bytes(pending.data, indent=pending.indent)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_path, path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def backup_files(paths: list[Path], backup_dir: Path) -> None:
    if backup_dir.exists():
        raise DataError(f"备份目录已存在，请换一个目录: {backup_dir}")
    for source in paths:
        relative_path = source.relative_to(DATA_DIR)
        destination = backup_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def restore_files(paths: list[Path], backup_dir: Path) -> None:
    errors: list[str] = []
    for destination in paths:
        source = backup_dir / destination.relative_to(DATA_DIR)
        try:
            shutil.copy2(source, destination)
        except OSError as exc:
            errors.append(f"{destination}: {exc}")
    if errors:
        raise RuntimeError("恢复备份时发生错误:\n" + "\n".join(errors))


def build_plan(cutoff: datetime) -> tuple[dict[Path, PendingWrite], dict[str, int]]:
    writes: dict[Path, PendingWrite] = {}
    summary = {
        "course_files": 0,
        "course_files_changed": 0,
        "reviews_before": 0,
        "reviews_after": 0,
        "reviews_removed": 0,
        "courses_emptied": 0,
        "index_before": 0,
        "index_after": 0,
        "index_removed": 0,
        "index_added": 0,
        "teacher_files": 0,
        "teacher_files_changed": 0,
        "teacher_courses_updated": 0,
        "manifest_before": 0,
        "manifest_after": 0,
    }

    if not COURSES_DIR.is_dir():
        raise DataError(f"课程目录不存在: {COURSES_DIR}")
    if not TEACHERS_DIR.is_dir():
        raise DataError(f"教师目录不存在: {TEACHERS_DIR}")

    course_stats: dict[int, CourseStats] = {}
    for path in sorted(COURSES_DIR.glob("*.json"), key=course_id_from_path):
        course_id = course_id_from_path(path)
        if course_id in course_stats:
            raise DataError(f"发现重复课程 ID: {course_id}")

        original = load_json(path)
        if not isinstance(original, dict) or not isinstance(original.get("results"), list):
            raise DataError(f"课程文件缺少 results 数组: {path}")

        old_results = original["results"]
        new_results: list[dict[str, Any]] = []
        for index, review in enumerate(old_results):
            if not isinstance(review, dict):
                raise DataError(f"{path}: results[{index}] 不是对象")
            created_at = parse_datetime(
                review.get("created_at"),
                label=f"{path}: results[{index}].created_at",
            )
            if created_at >= cutoff:
                new_results.append(review)

        stats = calculate_stats(new_results, source=path)
        course_stats[course_id] = stats

        updated = copy.deepcopy(original)
        updated["results"] = new_results
        updated["count"] = stats.count

        summary["course_files"] += 1
        summary["reviews_before"] += len(old_results)
        summary["reviews_after"] += stats.count
        removed = len(old_results) - stats.count
        summary["reviews_removed"] += removed
        if old_results and not new_results:
            summary["courses_emptied"] += 1
        if original != updated:
            summary["course_files_changed"] += 1
        add_write_if_changed(writes, path, original, updated, indent=2)

    # 更新并修复 with_comment_index：零评论条目删除，正评论条目重算。
    index_original = load_json(WITH_COMMENT_PATH)
    if not isinstance(index_original, dict) or not isinstance(
        index_original.get("courses"), dict
    ):
        raise DataError(f"索引缺少 courses 对象: {WITH_COMMENT_PATH}")
    index_updated = copy.deepcopy(index_original)
    old_index_courses = index_original["courses"]
    new_index_courses: dict[str, dict[str, Any]] = {}
    indexed_ids: set[int] = set()

    for key, raw_info in old_index_courses.items():
        if not isinstance(raw_info, dict):
            raise DataError(f"{WITH_COMMENT_PATH}: courses[{key!r}] 不是对象")
        course_id = normalize_id(
            raw_info.get("sqid"), label=f"索引课程 {key!r} 的 sqid"
        )
        if course_id in indexed_ids:
            raise DataError(f"with_comment_index.json 中 sqid 重复: {course_id}")
        indexed_ids.add(course_id)
        stats = course_stats.get(course_id, CourseStats(0, 0.0))
        if stats.count == 0:
            summary["index_removed"] += 1
            continue
        info = copy.deepcopy(raw_info)
        info["count"] = stats.count
        info["avg"] = stats.avg
        new_index_courses[key] = info

    # 正评论课程原则上应已在索引内；若缺失，则从 full_index 补齐元数据。
    missing_positive_ids = {
        course_id
        for course_id, stats in course_stats.items()
        if stats.count > 0 and course_id not in indexed_ids
    }
    if missing_positive_ids:
        full_index = load_json(FULL_INDEX_PATH)
        if not isinstance(full_index, dict) or not isinstance(
            full_index.get("courses"), dict
        ):
            raise DataError(f"完整索引缺少 courses 对象: {FULL_INDEX_PATH}")
        full_by_id: dict[int, tuple[str, dict[str, Any]]] = {}
        for key, raw_info in full_index["courses"].items():
            if not isinstance(raw_info, dict) or raw_info.get("sqid") is None:
                continue
            course_id = normalize_id(
                raw_info["sqid"], label=f"完整索引课程 {key!r} 的 sqid"
            )
            full_by_id[course_id] = (key, raw_info)

        for course_id in sorted(missing_positive_ids):
            if course_id not in full_by_id:
                raise DataError(
                    f"课程 {course_id} 有评论，但在 with_comment_index.json 和 "
                    "full_index.json 中都找不到元数据"
                )
            key, raw_info = full_by_id[course_id]
            if key in new_index_courses:
                raise DataError(f"补齐索引时键名冲突: {key!r}")
            info = copy.deepcopy(raw_info)
            info["count"] = course_stats[course_id].count
            info["avg"] = course_stats[course_id].avg
            new_index_courses[key] = info
            summary["index_added"] += 1

    index_updated["courses"] = new_index_courses
    summary["index_before"] = len(old_index_courses)
    summary["index_after"] = len(new_index_courses)
    add_write_if_changed(
        writes,
        WITH_COMMENT_PATH,
        index_original,
        index_updated,
        indent=2,
    )

    # 所有教师课程均以课程文件为准；没有课程文件即视为零评论。
    teacher_references: set[int] = set()
    for path in sorted(TEACHERS_DIR.glob("*.json"), key=course_id_from_path):
        original = load_json(path)
        if not isinstance(original, dict) or not isinstance(
            original.get("related_courses"), list
        ):
            raise DataError(f"教师文件缺少 related_courses 数组: {path}")
        updated = copy.deepcopy(original)
        file_updates = 0
        for index, course in enumerate(updated["related_courses"]):
            if not isinstance(course, dict):
                raise DataError(f"{path}: related_courses[{index}] 不是对象")
            course_id = normalize_id(
                course.get("id"),
                label=f"{path}: related_courses[{index}].id",
            )
            teacher_references.add(course_id)
            stats = course_stats.get(course_id, CourseStats(0, 0.0))
            if course.get("count") != stats.count or course.get("avg") != stats.avg:
                course["count"] = stats.count
                course["avg"] = stats.avg
                file_updates += 1

        summary["teacher_files"] += 1
        summary["teacher_courses_updated"] += file_updates
        if original != updated:
            summary["teacher_files_changed"] += 1
        add_write_if_changed(writes, path, original, updated, indent=4)

    unreferenced_positive = sorted(
        course_id
        for course_id, stats in course_stats.items()
        if stats.count > 0 and course_id not in teacher_references
    )
    if unreferenced_positive:
        preview = ", ".join(map(str, unreferenced_positive[:10]))
        suffix = " ..." if len(unreferenced_positive) > 10 else ""
        raise DataError(
            "以下有评论课程未出现在任何教师的 related_courses 中: "
            f"{preview}{suffix}"
        )

    manifest_original = load_json(MANIFEST_PATH)
    if not isinstance(manifest_original, dict):
        raise DataError(f"manifest 顶层必须是对象: {MANIFEST_PATH}")
    manifest_updated = copy.deepcopy(manifest_original)
    total_reviews = sum(stats.count for stats in course_stats.values())
    old_total_reviews = manifest_original.get("total_reviews", 0)
    if not isinstance(old_total_reviews, int):
        raise DataError(f"manifest.total_reviews 必须是整数: {old_total_reviews!r}")
    manifest_updated["total_reviews"] = total_reviews
    summary["manifest_before"] = old_total_reviews
    summary["manifest_after"] = total_reviews
    add_write_if_changed(
        writes,
        MANIFEST_PATH,
        manifest_original,
        manifest_updated,
        indent=2,
    )

    return writes, summary


def print_summary(summary: dict[str, int], write_count: int) -> None:
    print(f"课程文件: {summary['course_files']} 个")
    print(
        "评论总数: "
        f"{summary['reviews_before']} -> {summary['reviews_after']} "
        f"（删除 {summary['reviews_removed']} 条）"
    )
    print(
        f"课程文件将修改: {summary['course_files_changed']} 个；"
        f"评论归零课程: {summary['courses_emptied']} 门"
    )
    print(
        "with_comment_index: "
        f"{summary['index_before']} -> {summary['index_after']} 条 "
        f"（删除 {summary['index_removed']}，补齐 {summary['index_added']}）"
    )
    print(
        f"教师文件将修改: {summary['teacher_files_changed']} / "
        f"{summary['teacher_files']} 个；"
        f"教师课程数据将更新: {summary['teacher_courses_updated']} 条"
    )
    print(
        "manifest.total_reviews: "
        f"{summary['manifest_before']} -> {summary['manifest_after']}"
    )
    print(f"合计将写入: {write_count} 个文件")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "删除 main/data/courses 中 created_at 严格早于指定时间的评论，"
            "并同步课程统计、教师数据、评论索引和 manifest。"
        )
    )
    parser.add_argument(
        "--before",
        required=True,
        metavar="TIME",
        help='截止时间，例如 "2025-01-01" 或 "2025-01-01 12:30"',
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="实际写入；不加此参数时仅预览",
    )
    parser.add_argument(
        "--backup-dir",
        type=Path,
        help="自定义备份目录；默认写入 main/data/backups/ 下的时间戳目录",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        cutoff = parse_datetime(args.before, label="--before")
        writes, summary = build_plan(cutoff)
        print(f"截止时间: {cutoff:%Y-%m-%d %H:%M:%S}（严格早于）")
        print_summary(summary, len(writes))

        if not args.apply:
            print("\n当前为预览模式，未修改任何文件。确认后加 --apply 执行。")
            return 0

        if not writes:
            print("\n所有数据已经一致，无需写入。")
            return 0

        backup_dir = args.backup_dir
        if backup_dir is None:
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            backup_dir = DATA_DIR / "backups" / f"reviews_before_{stamp}"
        else:
            backup_dir = backup_dir.expanduser().resolve()

        paths = sorted(writes)
        backup_files(paths, backup_dir)
        print(f"\n备份已创建: {backup_dir}")
        try:
            for path in paths:
                atomic_write_json(path, writes[path])
        except Exception as write_error:
            print(f"写入失败，正在从备份恢复: {write_error}", file=sys.stderr)
            try:
                restore_files(paths, backup_dir)
            except Exception as restore_error:
                print(f"自动恢复失败: {restore_error}", file=sys.stderr)
            raise

        print(f"清理完成，共写入 {len(paths)} 个文件。")
        return 0
    except (DataError, OSError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
