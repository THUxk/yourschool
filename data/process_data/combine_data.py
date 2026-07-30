'''
从网络学堂获取最新数据后更新数据库
'''

import os
import json
import time
import re
import normalize

new_index = {}
courses_new = {}
teachers_new = {}
new_course_id = 38094
new_teacher_id = 7422
# no_comment_courses = True


with open("./data/full_index.json", 'r', encoding='utf-8') as f:
    origin_index = json.load(f)

with open("./data/simple_index.json", 'r', encoding='utf-8') as f:
    teacher_index = json.load(f)["teachers"]

# # 对索引中的键名做括号规范化，便于后续匹配
# index = {}
# for section in ['teachers', 'courses']:
#     index[section] = {normalize_parens(k): v for k, v in raw_index[section].items()} if section in raw_index else {}

def combine_data(item: dict):
    global new_course_id, new_teacher_id

    course_name = normalize.kcm(item['kcm']) # 课程名称
    # kch = item['kch']
    teacher_name = normalize.jsm(item['jsmc']) # 教师姓名
    # jsh = item['jsh']
    full_name = f"{course_name}({teacher_name})"
    # xnxq = item['xnxq'] # 学年学期
    # semester_offered = []
    kkdw = item['kkdw'] # 开课单位

    # 查找特定课程是否已被处理
    if full_name in courses_new:
        return

    # 查找该课程在选课社区中是否已存在
    if full_name in origin_index["courses"]:
        return
    else:
        yourschool_id = new_course_id
        new_course_id += 1
        print(f"New course found: {full_name}, assigned new id: {yourschool_id}")
        
    # 查找教师在选课社区中的id
    if teacher_name in teacher_index:
        # 如果教师已存在，添加新课程的信息
        tid = teacher_index[teacher_name]
        with open(f"./data/teachers/{tid}.json", "r", encoding="utf-8") as f:
            teacher_info = json.load(f)
        teacher_info["related_courses"].append({
            "id": yourschool_id,
            "code": "",
            "name": course_name,
            "avg": 0.0,
            "count": 0
        })
        with open(f"./data/teachers/{tid}.json", "w", encoding="utf-8") as f:
            json.dump(teacher_info, f, ensure_ascii=False, indent=4)

    else:
        # 如果教师不存在，创建新的教师信息
        tid = new_teacher_id
        new_teacher_id += 1
        teachers_new[teacher_name] = tid
        print(f"New teacher found: {teacher_name}, assigned new id: {tid}")
        with open(f"./data/teachers/{tid}.json", "w", encoding="utf-8") as f:
            teacher_info = {
                "tid": str(tid),
                "name": teacher_name,
                "related_courses": [{
                    "id": yourschool_id,
                    "code": "",
                    "name": course_name,
                    "avg": 0.0,
                    "count": 0
                }]
            }
            json.dump(teacher_info, f, ensure_ascii=False, indent=4)

    # # 获取评分
    # path = f'./data/courses/{yourschool_id}.json'
    # if os.path.exists(path):
    #     with open(path, 'r', encoding='utf-8') as f:
    #         comment_data = json.load(f)
    #     count = comment_data.get("count", 0)
    #     avg = sum(map(lambda x: x.get("rating", 0), comment_data.get("results", []))) / count if count > 0 else 0.0
    # else:
    #     count = 0
    #     avg = 0.0

        
    course_data = {
        "kcm": course_name,
        # "kch": [kch],
        "sqid": yourschool_id,
        "jsm": teacher_name,
        # "jsh": jsh,
        "tid": tid,
        "kkdw": kkdw,
        # "xnxq": [xnxq],
        # "count": count,
        # "avg": avg
    }
    courses_new[full_name] = course_data



def main():
    with open("./data/learn/courses_2026-2027-1.json", 'r', encoding='utf-8') as f:
        # 打开从网络学堂获取到数据
        learn_courses = json.load(f)["object"]["aaData"]
    for item in learn_courses:
        try:
            combine_data(item)
        except Exception as e:
            print(f"Error processing item: {item}, error: {e}")
    
    # if not no_comment_courses:
    #     courses_with_comments = {name: data for name, data in courses_new.items() if data["count"] > 0}                

    # data = {
    #     "courses": courses_with_comments if not no_comment_courses else courses_new,
        # "teachers": teachers_new
    # }
    with open("./data/simple_index.json", 'r', encoding='utf-8') as f:
        data = json.load(f)
    # 将新课程、新教师信息写入精简索引
    data["teachers"].update(teachers_new)
    data["courses"].update({name: data["sqid"] for name, data in courses_new.items()})
    with open("./data/simple_index.json", 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    with open(f"./data/log_{time.strftime('%Y-%m-%d_%H-%M-%S')}.json", 'w', encoding='utf-8') as f:
        # 记录本次运行中新发现的课程和教师信息
        json.dump({"courses": list(courses_new.keys()), "teachers": list(teachers_new.keys())}, f, ensure_ascii=False, indent=4)

    with open("./data/full_index.json", 'r', encoding='utf-8') as f:
        data = json.load(f)
    # 将新课程信息写入完整索引
    # with open("./data/with_comment_index.json", 'w', encoding='utf-8') as f:
    data["courses"].update(courses_new)
    with open("./data/full_index.json", 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

if __name__ == "__main__":
    start_time = time.time()
    main()
    end_time = time.time()
    print(f"Data combined in {end_time - start_time:.2f} seconds")