"""
优化 full_index.json — 移除前端未使用的字段以减小文件体积。

移除字段：
  - count (评论数) — JS 代码中未使用
  - avg (平均评分) — JS 代码中未使用

预期效果：15.5 MB → 约 8-10 MB
"""

import json
import os
import sys

def optimize_index(input_path, output_path=None):
    """优化索引文件，移除未使用字段"""
    if output_path is None:
        output_path = input_path

    print(f"读取: {input_path}")
    with open(input_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    courses = data.get('courses', {})
    total = len(courses)
    print(f"课程总数: {total}")

    # 统计移除的字段
    removed_count = 0
    removed_avg = 0

    for key, info in courses.items():
        if isinstance(info, dict):
            if 'count' in info:
                del info['count']
                removed_count += 1
            if 'avg' in info:
                del info['avg']
                removed_avg += 1

    print(f"移除了 {removed_count} 个 count 字段")
    print(f"移除了 {removed_avg} 个 avg 字段")

    # 写入优化后的文件
    print(f"写入: {output_path}")
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    # 报告文件大小
    orig_size = os.path.getsize(input_path)
    new_size = os.path.getsize(output_path)
    reduction = (1 - new_size / orig_size) * 100 if orig_size > 0 else 0
    print(f"原始大小: {orig_size/1024/1024:.1f} MB")
    print(f"优化大小: {new_size/1024/1024:.1f} MB")
    print(f"减小比例: {reduction:.1f}%")

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(script_dir, 'full_index.json')
    
    if not os.path.exists(target):
        print(f"错误: 找不到 {target}")
        sys.exit(1)
    
    optimize_index(target)
    print("\n完成！")
