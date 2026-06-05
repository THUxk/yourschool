#!/usr/bin/env python3
"""
清理课程点评数据：
1. 遍历 /main/data/courses/ 下所有 JSON 文件
2. 去除重复 comment（相同内容仅保留一条）
3. 删除长度 < 3 个字符的 comment
4. 重新计算 count 与 avg (average rating)
5. 更新 with_comment_index.json 中对应的 count 与 avg
6. 重新计算总点评数，更新 manifest.json
"""

import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
COURSES_DIR = os.path.join(BASE_DIR, "courses")
WITH_COMMENT_PATH = os.path.join(BASE_DIR, "with_comment_index.json")
MANIFEST_PATH = os.path.join(BASE_DIR, "manifest.json")

MIN_COMMENT_LENGTH = 3  # 少于此长度的 comment 将被删除


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def clean_course_file(filepath):
    """清理单个课程文件，返回 (old_count, new_count, new_avg, removed_dupes, removed_short, modified_data)"""
    data = load_json(filepath)
    results = data.get("results", [])
    old_count = len(results)

    if not results:
        return old_count, 0, None, 0, 0, None

    # Step 1: 去重 —— 相同 comment 仅保留第一条
    seen_comments = set()
    deduped = []
    removed_dupes = 0
    for item in results:
        comment = (item.get("comment") or "").strip()
        if comment not in seen_comments:
            seen_comments.add(comment)
            deduped.append(item)
        else:
            removed_dupes += 1

    # Step 2: 删除长度 < MIN_COMMENT_LENGTH 的 comment
    before_short_filter = len(deduped)
    filtered = [
        item for item in deduped
        if len((item.get("comment") or "").strip()) >= MIN_COMMENT_LENGTH
    ]
    removed_short = before_short_filter - len(filtered)

    new_count = len(filtered)

    # Step 3: 计算平均评分 (保留一位小数)
    ratings = [item["rating"] for item in filtered if "rating" in item and item["rating"] is not None]
    new_avg = round(sum(ratings) / len(ratings), 1) if ratings else None

    # 更新数据
    data["results"] = filtered
    data["count"] = new_count
    data["next"] = None
    data["previous"] = None

    return old_count, new_count, new_avg, removed_dupes, removed_short, data


def main():
    print("=" * 60)
    print("课程点评数据清理脚本")
    print(f"  - 去重: 相同 comment 仅保留第一条")
    print(f"  - 删短: 删除长度 < {MIN_COMMENT_LENGTH} 字符的 comment")
    print(f"  - 重算: count / avg")
    print("=" * 60)

    # ---- 1. 加载 with_comment_index.json，建立 sqid -> key 映射 ----
    print("\n[1/4] 加载 with_comment_index.json ...")
    with_comment = load_json(WITH_COMMENT_PATH)
    courses_index = with_comment.get("courses", {})

    # sqid -> course_key 映射
    sqid_to_key = {}
    for key, info in courses_index.items():
        sqid = info.get("sqid")
        if sqid is not None:
            sqid_to_key[sqid] = key

    print(f"  共 {len(courses_index)} 个有评论课程条目")

    # ---- 2. 遍历 courses 目录 ----
    print("\n[2/4] 遍历课程文件 ...")
    course_files = sorted(
        [f for f in os.listdir(COURSES_DIR) if f.endswith(".json")],
        key=lambda x: int(x.replace(".json", "")) if x.replace(".json", "").isdigit() else 0
    )

    total_old = 0
    total_new = 0
    total_dupes = 0
    total_short = 0
    modified_files = 0
    index_updates = 0

    for filename in course_files:
        filepath = os.path.join(COURSES_DIR, filename)
        try:
            sqid = int(filename.replace(".json", ""))
        except ValueError:
            print(f"  ⚠ 跳过非数字文件名: {filename}")
            continue

        old_count, new_count, new_avg, dupes, short, modified_data = clean_course_file(filepath)

        total_old += old_count
        total_new += new_count
        total_dupes += dupes
        total_short += short

        if old_count != new_count and modified_data is not None:
            modified_files += 1
            save_json(filepath, modified_data)

        # 更新 with_comment_index.json
        if sqid in sqid_to_key:
            key = sqid_to_key[sqid]
            old_entry_count = courses_index[key].get("count", 0)
            courses_index[key]["count"] = new_count
            if new_avg is not None:
                courses_index[key]["avg"] = new_avg
            elif new_count == 0:
                courses_index[key]["avg"] = 0
            if old_entry_count != new_count:
                index_updates += 1

    print(f"\n  📊 统计:")
    print(f"     处理文件数: {len(course_files)}")
    print(f"     修改文件数: {modified_files}")
    print(f"     原有评论数: {total_old}")
    print(f"     去重删除:   {total_dupes}")
    print(f"     过短删除:   {total_short}")
    print(f"     清理后评论: {total_new}")

    # ---- 3. 写回 with_comment_index.json ----
    print("\n[3/4] 更新 with_comment_index.json ...")
    if index_updates > 0:
        save_json(WITH_COMMENT_PATH, with_comment)
        print(f"  共更新 {index_updates} 个课程条目")
    else:
        print("  无需更新")

    # ---- 4. 重新计算总点评数，更新 manifest.json ----
    print("\n[4/4] 更新 manifest.json ...")
    total_reviews = sum(info.get("count", 0) for info in courses_index.values())
    manifest = load_json(MANIFEST_PATH)
    old_total_reviews = manifest.get("total_reviews", 0)
    manifest["total_reviews"] = total_reviews
    save_json(MANIFEST_PATH, manifest)
    print(f"  total_reviews: {old_total_reviews} → {total_reviews}")

    print("\n" + "=" * 60)
    print("✅ 清理完成！")
    print("=" * 60)


if __name__ == "__main__":
    main()
