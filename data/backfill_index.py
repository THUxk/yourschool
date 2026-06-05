"""
回填 with_comment_index.json 中缺失的课程条目。

用法: python backfill_index.py
功能:
  1. 扫描 data/courses/ 中所有课程文件
  2. 对比 with_comment_index.json，找出缺失的课程
  3. 从 full_index.json 查找课程元信息
  4. 将缺失条目补充到 with_comment_index.json
"""
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
COURSES_DIR = os.path.join(SCRIPT_DIR, 'courses')
FULL_INDEX_PATH = os.path.join(SCRIPT_DIR, 'full_index.json')
WITH_COMMENT_PATH = os.path.join(SCRIPT_DIR, 'with_comment_index.json')


def main():
    # 加载 full_index.json
    print(f"加载 {FULL_INDEX_PATH} ...")
    with open(FULL_INDEX_PATH, 'r', encoding='utf-8') as f:
        full_index = json.load(f)
    full_courses = full_index['courses']
    print(f"  full_index.json: {len(full_courses)} 门课程")

    # 构建 sqid -> (key, metadata) 的映射
    sqid_to_info = {}
    for key, info in full_courses.items():
        sqid = info.get('sqid')
        if sqid is not None:
            sqid_to_info[sqid] = (key, info)
    print(f"  sqid 映射: {len(sqid_to_info)} 条")

    # 加载 with_comment_index.json
    print(f"加载 {WITH_COMMENT_PATH} ...")
    with open(WITH_COMMENT_PATH, 'r', encoding='utf-8') as f:
        wci = json.load(f)
    wci_courses = wci.get('courses', {})
    print(f"  with_comment_index.json: {len(wci_courses)} 门课程")

    # 扫描所有课程文件
    print(f"扫描 {COURSES_DIR} ...")
    course_files = [f for f in os.listdir(COURSES_DIR) if f.endswith('.json')]
    print(f"  课程文件: {len(course_files)} 个")

    # 找出缺失的课程
    added = 0
    skipped_no_full = 0
    skipped_already = 0

    for filename in course_files:
        sqid_str = filename.replace('.json', '')
        try:
            sqid = int(sqid_str)
        except ValueError:
            print(f"  ⚠️ 跳过非法文件名: {filename}")
            continue

        # 检查是否已在 with_comment_index 中
        already_in = any(
            v.get('sqid') == sqid for v in wci_courses.values()
        )
        if already_in:
            skipped_already += 1
            continue

        # 加载课程文件获取 count 和 avg
        course_path = os.path.join(COURSES_DIR, filename)
        with open(course_path, 'r', encoding='utf-8') as f:
            course_data = json.load(f)

        count = course_data.get('count', 0)
        ratings = [r.get('rating', 0) for r in course_data.get('results', [])]
        avg = sum(ratings) / len(ratings) if ratings else 0
        avg = round(avg, 1)  # 保留一位小数

        # 从 full_index.json 查找课程元信息
        if sqid in sqid_to_info:
            key, info = sqid_to_info[sqid]
            new_entry = dict(info)  # 复制元信息
            new_entry['count'] = count
            new_entry['avg'] = avg
            # 确保没有 count/avg 残留（来自旧的 full_index）
            new_entry.pop('count', None)
            new_entry.pop('avg', None)
            new_entry['count'] = count
            new_entry['avg'] = avg

            wci_courses[key] = new_entry
            added += 1
            print(f"  ✅ 回填: sqid={sqid} -> {key} (count={count}, avg={avg})")
        else:
            # 在 full_index.json 中也找不到，使用回退条目
            fallback_key = f"__unknown__{sqid}"
            new_entry = {
                "kcm": "(unknown)",
                "sqid": sqid,
                "jsm": "(unknown)",
                "tid": 0,
                "kkdw": "(unknown)",
                "count": count,
                "avg": avg,
            }
            wci_courses[fallback_key] = new_entry
            added += 1
            skipped_no_full += 1
            print(f"  ⚠️ 回填(回退): sqid={sqid} -> {fallback_key} (count={count}, avg={avg})")

    # 写回 with_comment_index.json
    if added > 0:
        wci['courses'] = wci_courses
        print(f"\n写入 {WITH_COMMENT_PATH} ...")
        with open(WITH_COMMENT_PATH, 'w', encoding='utf-8') as f:
            json.dump(wci, f, ensure_ascii=False, indent=2)
        print(f"完成! 新增 {added} 门课程 (其中 {skipped_no_full} 门使用回退条目)")
        print(f"  已在索引中: {skipped_already}")
        print(f"  with_comment_index.json 现在有 {len(wci_courses)} 门课程")
    else:
        print(f"\n无需更新，所有课程已在索引中。")


if __name__ == '__main__':
    main()
